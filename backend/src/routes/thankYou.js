const router = require("express").Router();
const db = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const { thankYouValidation, validateRequest } = require("../middleware/validation");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../config/logger");
const { sendThankYouEmail } = require("../services/emailService");
const { createNotification } = require("../services/notifications");

const BULK_THANK_YOU_CONCURRENCY = parseInt(process.env.BULK_THANK_YOU_CONCURRENCY || "10", 10);
const BULK_THANK_YOU_CHUNK_SIZE = parseInt(process.env.BULK_THANK_YOU_CHUNK_SIZE || "500", 10);

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
}

/**
 * Executes a list of async tasks with a maximum concurrency limit.
 * Per-item errors are isolated and logged so individual failures do not abort the batch.
 */
async function runWithConcurrency(items, limit, fn) {
  let index = 0;
  let sentCount = 0;
  let failedCount = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      try {
        await fn(item);
        sentCount++;
      } catch (err) {
        failedCount++;
        logger.error("Thank-you delivery error for contributor", {
          recipientId: item.id,
          recipientEmail: item.email,
          error: err.message,
        });
      }
    }
  });

  await Promise.all(workers);
  return { sentCount, failedCount };
}

/**
 * @openapi
 * /api/campaigns/{id}/thank-you:
 *   get:
 *     tags: [Thank You]
 *     summary: List thank-you delivery history for a campaign
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of thank-you messages with delivery metrics
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Campaign not found
 */
router.get(
  "/campaigns/:id/thank-you",
  requireAuth,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const { rows: campaignRows } = await db.query(
      "SELECT id, creator_id FROM campaigns WHERE id = $1",
      [campaignId],
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaignRows[0].creator_id !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the campaign creator can view thank-you history" });
    }

    const { rows } = await db.query(
      `SELECT id, campaign_id, creator_id, contribution_id, message, type,
              COALESCE(total_recipients, 0) AS total_recipients,
              COALESCE(sent_count, 0) AS sent_count,
              COALESCE(failed_count, 0) AS failed_count,
              COALESCE(status, 'completed') AS status,
              sent_at
       FROM thank_you_messages
       WHERE campaign_id = $1
       ORDER BY sent_at DESC`,
      [campaignId],
    );

    return res.json(rows);
  }),
);

// POST /api/contributions/:id/thank-you — individual thank-you to a specific contributor
router.post(
  "/contributions/:id/thank-you",
  requireAuth,
  thankYouValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const contributionId = req.params.id;
    const { message } = req.body;

    const { rows: contribRows } = await db.query(
      `SELECT ct.id, ct.campaign_id, ct.sender_public_key,
              c.creator_id, c.title AS campaign_title
       FROM contributions ct
       JOIN campaigns c ON c.id = ct.campaign_id
       WHERE ct.id = $1`,
      [contributionId],
    );

    if (!contribRows.length) {
      return res.status(404).json({ error: "Contribution not found" });
    }

    const contribution = contribRows[0];
    if (contribution.creator_id !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the campaign creator can send thank-you messages" });
    }

    const { rows } = await db.query(
      `INSERT INTO thank_you_messages (campaign_id, creator_id, contribution_id, message, type)
       VALUES ($1, $2, $3, $4, 'individual')
       RETURNING id, campaign_id, creator_id, contribution_id, message, type, sent_at`,
      [contribution.campaign_id, req.user.userId, contributionId, message],
    );
    const thankYou = rows[0];

    setImmediate(async () => {
      const campaignUrl = `${frontendBaseUrl()}/campaigns/${contribution.campaign_id}`;

      try {
        const { rows: users } = await db.query(
          `SELECT u.id, u.email, u.name
           FROM users u
           WHERE u.wallet_public_key = $1`,
          [contribution.sender_public_key],
        );

        if (!users.length) {
          await db.query(
            `UPDATE thank_you_messages SET total_recipients = 1, failed_count = 1, status = 'completed' WHERE id = $1`,
            [thankYou.id],
          ).catch(() => {});
          return;
        }

        const contributor = users[0];

        createNotification(contributor.id, {
          type: "thank_you",
          title: `Thank you from ${contribution.campaign_title}`,
          body: message.length > 200 ? `${message.slice(0, 200).trim()}…` : message,
          link: `/campaigns/${contribution.campaign_id}`,
        }).catch((err) =>
          logger.error("Thank-you notification failed", {
            userId: contributor.id,
            error: err.message,
          }),
        );

        await sendThankYouEmail({
          to: contributor.email,
          messageId: thankYou.id,
          campaignId: contribution.campaign_id,
          name: contributor.name,
          campaignTitle: contribution.campaign_title,
          message,
          campaignUrl,
        });

        await db.query(
          `UPDATE thank_you_messages SET total_recipients = 1, sent_count = 1, status = 'completed' WHERE id = $1`,
          [thankYou.id],
        ).catch(() => {});
      } catch (err) {
        logger.error("Individual thank-you delivery failed", { error: err.message });
        await db.query(
          `UPDATE thank_you_messages SET total_recipients = 1, failed_count = 1, status = 'completed' WHERE id = $1`,
          [thankYou.id],
        ).catch(() => {});
      }
    });

    return res.status(201).json(thankYou);
  }),
);

// POST /api/campaigns/:id/thank-you — bulk thank-you to all contributors (rate-limited: 1/24h)
router.post(
  "/campaigns/:id/thank-you",
  requireAuth,
  thankYouValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const message = req.body.message;
    const isTest = process.env.NODE_ENV === "test";

    const { rows: campaignRows } = await db.query(
      "SELECT id, creator_id, title FROM campaigns WHERE id = $1",
      [campaignId],
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    if (campaignRows[0].creator_id !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the campaign creator can send thank-you messages" });
    }

    // Check rate limit: one bulk thank-you per 24h per campaign per creator
    if (!isTest) {
      const { rows: recent } = await db.query(
        `SELECT 1 FROM thank_you_messages
         WHERE campaign_id = $1 AND creator_id = $2 AND type = 'bulk'
           AND sent_at > NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [campaignId, req.user.userId],
      );

      if (recent.length) {
        return res.status(429).json({ error: "You can send one bulk thank-you per campaign per day" });
      }
    }

    const { rows: contributors } = await db.query(
      `SELECT DISTINCT ON (u.id) u.id, u.email, u.name
       FROM contributions c
       JOIN users u ON u.wallet_public_key = c.sender_public_key
       WHERE c.campaign_id = $1 AND u.email IS NOT NULL
       ORDER BY u.id, c.created_at DESC`,
      [campaignId],
    );

    const { rows } = await db.query(
      `INSERT INTO thank_you_messages (campaign_id, creator_id, message, type)
       VALUES ($1, $2, $3, 'bulk')
       RETURNING id, campaign_id, creator_id, message, type, sent_at`,
      [campaignId, req.user.userId, message],
    );
    const thankYou = rows[0];

    res.status(201).json({ ...thankYou, recipient_count: contributors.length });

    setImmediate(async () => {
      const campaignUrl = `${frontendBaseUrl()}/campaigns/${campaignId}`;
      let totalSent = 0;
      let totalFailed = 0;

      try {
        await db.query(
          `UPDATE thank_you_messages SET total_recipients = $1, status = 'processing' WHERE id = $2`,
          [contributors.length, thankYou.id],
        ).catch(() => {});

        // Process contributors in bounded batches with concurrency limiter
        for (let i = 0; i < contributors.length; i += BULK_THANK_YOU_CHUNK_SIZE) {
          const chunk = contributors.slice(i, i + BULK_THANK_YOU_CHUNK_SIZE);
          const { sentCount, failedCount } = await runWithConcurrency(
            chunk,
            BULK_THANK_YOU_CONCURRENCY,
            async (contributor) => {
              createNotification(contributor.id, {
                type: "thank_you",
                title: `Thank you from ${campaignRows[0].title}`,
                body: message.length > 200 ? `${message.slice(0, 200).trim()}…` : message,
                link: `/campaigns/${campaignId}`,
              }).catch((err) =>
                logger.error("Thank-you notification failed", {
                  userId: contributor.id,
                  error: err.message,
                }),
              );

              return sendThankYouEmail({
                to: contributor.email,
                messageId: thankYou.id,
                campaignId,
                name: contributor.name,
                campaignTitle: campaignRows[0].title,
                message,
                campaignUrl,
              });
            },
          );
          totalSent += sentCount;
          totalFailed += failedCount;
        }

        await db.query(
          `UPDATE thank_you_messages
           SET total_recipients = $1, sent_count = $2, failed_count = $3, status = 'completed'
           WHERE id = $4`,
          [contributors.length, totalSent, totalFailed, thankYou.id],
        ).catch(() => {});
      } catch (err) {
        logger.error("Bulk thank-you delivery failed", { error: err.message });
        await db.query(
          `UPDATE thank_you_messages
           SET total_recipients = $1, sent_count = $2, failed_count = $3, status = 'failed'
           WHERE id = $4`,
          [contributors.length, totalSent, totalFailed, thankYou.id],
        ).catch(() => {});
      }
    });
  }),
);

module.exports = router;
