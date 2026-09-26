const router = require("express").Router();
const db = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../config/logger");
const { sendCampaignUpdatePostedEmail } = require("../services/emailService");
const { createNotification } = require("../services/notifications");
const { notifyFollowers } = require("../services/campaignFollowService");
const {
  CAMPAIGN_UPDATE_BODY_MAX_LENGTH,
} = require("../middleware/validation");

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
}

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, "")
    .trim();
}

function validateAttachments(attachments) {
  if (!attachments) return '[]';
  if (!Array.isArray(attachments)) {
    const err = new Error("Attachments must be an array");
    err.statusCode = 422;
    throw err;
  }
  if (attachments.length > 5) {
    const err = new Error("Maximum 5 attachments allowed per update");
    err.statusCode = 422;
    throw err;
  }
  const validTypes = ['image', 'video', 'document'];
  for (const att of attachments) {
    if (!att.url || typeof att.url !== 'string') {
      const err = new Error("Attachment must include url");
      err.statusCode = 422;
      throw err;
    }
    if (!validTypes.includes(att.type)) {
      const err = new Error("Attachment type must be image, video, or document");
      err.statusCode = 422;
      throw err;
    }
    if (typeof att.size !== 'number') {
      const err = new Error("Attachment must include numerical size");
      err.statusCode = 422;
      throw err;
    }
    if (['image', 'video'].includes(att.type)) {
      if (!att.alt_text || typeof att.alt_text !== 'string' || att.alt_text.trim() === '') {
        const err = new Error("Image and video attachments must include alt_text for accessibility");
        err.statusCode = 422;
        throw err;
      }
    }
  }
  return JSON.stringify(attachments);
}

async function requireCampaignCreator(req, res, next) {
  const campaignId = req.params.id;

  const { rows } = await db.query(
    "SELECT id, creator_id, title FROM campaigns WHERE id = $1",
    [campaignId],
  );

  if (!rows.length) {
    return res.status(404).json({ error: "Campaign not found" });
  }

  if (rows[0].creator_id !== req.user.userId && req.user.role !== "admin") {
    return res.status(403).json({
      error: "Only the campaign creator can manage updates",
    });
  }

  req.campaign = rows[0];
  next();
}

// Public: list updates newest first
router.get(
  "/:id/updates",
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT cu.id,
            cu.campaign_id,
            cu.author_id,
            cu.title,
            cu.body,
            cu.attachments,
            cu.created_at,
            cu.updated_at,
            u.name AS author_name
     FROM campaign_updates cu
     JOIN users u ON u.id = cu.author_id
     WHERE cu.campaign_id = $1
     ORDER BY cu.created_at DESC`,
      [req.params.id],
    );

    res.json(rows);
  }),
);

// Creator only: create update
router.post(
  "/:id/updates",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const title = cleanText(req.body.title);
    const body = cleanText(req.body.body);
    let attachmentsJson = '[]';

    try {
      attachmentsJson = validateAttachments(req.body.attachments);
    } catch (err) {
      return res.status(err.statusCode || 422).json({ error: err.message });
    }

    if (!title) return res.status(422).json({ error: "Title is required" });
    if (!body) return res.status(422).json({ error: "Body is required" });
    if (body.length > CAMPAIGN_UPDATE_BODY_MAX_LENGTH) {
      return res.status(422).json({
        error: `Update body must be ${CAMPAIGN_UPDATE_BODY_MAX_LENGTH} characters or fewer`,
      });
    }

    const { rows } = await db.query(
      `INSERT INTO campaign_updates (campaign_id, author_id, title, body, attachments)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, campaign_id, author_id, title, body, attachments, created_at, updated_at`,
      [req.params.id, req.user.userId, title, body, attachmentsJson],
    );
    const update = rows[0];

    setImmediate(() => {
      const campaignUrl = `${frontendBaseUrl()}/campaigns/${req.params.id}`;
      const updateExcerpt =
        update.body.length > 200 ? `${update.body.slice(0, 200).trim()}…` : update.body;

      db.query(
        `SELECT DISTINCT ON (u.id) u.id, u.email, u.name
         FROM contributions c
         JOIN users u ON u.wallet_public_key = c.sender_public_key
         WHERE c.campaign_id = $1 AND u.email IS NOT NULL
         ORDER BY u.id, c.created_at ASC`,
        [req.params.id],
      )
        .then(({ rows: contributors }) => {
          notifyFollowers(
            req.params.id,
            "notify_updates",
            {
              type: "campaign_update",
              title: `${req.campaign.title}: ${update.title}`,
              body: updateExcerpt,
              link: `/campaigns/${req.params.id}`,
            },
            [req.user.userId, ...contributors.map((contributor) => contributor.id)],
          ).catch((err) =>
            logger.error("Campaign update follower notification failed", {
              campaignId: req.params.id,
              error: err.message,
            }),
          );

          return Promise.all(
            contributors.map((contributor) => {
              createNotification(contributor.id, {
                type: "campaign_update",
                title: `${req.campaign.title}: ${update.title}`,
                body: updateExcerpt,
                link: `/campaigns/${req.params.id}`,
              }).catch((err) =>
                logger.error("Campaign update notification failed", {
                  userId: contributor.id,
                  error: err.message,
                }),
              );

              return sendCampaignUpdatePostedEmail({
                to: contributor.email,
                updateId: update.id,
                campaignId: req.params.id,
                name: contributor.name,
                campaignTitle: req.campaign.title,
                campaignUrl,
                updateTitle: update.title,
                updateExcerpt,
                updateBody: update.body,
              });
            }),
          );
        })
        .catch((err) => logger.error("Campaign update email failed", { error: err.message }));
    });

    res.status(201).json(update);
  }),
);

// Creator only: edit update within 24 hours
router.patch(
  "/:id/updates/:updateId",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const title = cleanText(req.body.title);
    const body = cleanText(req.body.body);
    let attachmentsJson;

    try {
      attachmentsJson = validateAttachments(req.body.attachments);
    } catch (err) {
      return res.status(err.statusCode || 422).json({ error: err.message });
    }

    if (!title) return res.status(422).json({ error: "Title is required" });
    if (!body) return res.status(422).json({ error: "Body is required" });
    if (body.length > CAMPAIGN_UPDATE_BODY_MAX_LENGTH) {
      return res.status(422).json({
        error: `Update body must be ${CAMPAIGN_UPDATE_BODY_MAX_LENGTH} characters or fewer`,
      });
    }

    const { rows } = await db.query(
      `UPDATE campaign_updates
       SET title = $1,
           body = $2,
           attachments = $3::jsonb,
           updated_at = NOW()
       WHERE id = $4
         AND campaign_id = $5
         AND author_id = $6
         AND created_at >= NOW() - INTERVAL '24 hours'
       RETURNING id, campaign_id, author_id, title, body, attachments, created_at, updated_at`,
      [title, body, attachmentsJson, req.params.updateId, req.params.id, req.user.userId],
    );

    if (!rows.length) {
      return res.status(403).json({
        error: "Update not found or edit window has expired",
      });
    }

    res.json(rows[0]);
  }),
);

// Creator only: delete update
router.delete(
  "/:id/updates/:updateId",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { rowCount } = await db.query(
      `DELETE FROM campaign_updates
       WHERE id = $1
         AND campaign_id = $2
         AND author_id = $3`,
      [req.params.updateId, req.params.id, req.user.userId],
    );

    if (!rowCount) {
      return res.status(404).json({ error: "Update not found" });
    }

    res.status(204).send();
  }),
);

module.exports = router;
