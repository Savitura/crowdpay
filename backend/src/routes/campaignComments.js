const router = require("express").Router();
const db = require("../config/database");
const { requireAuth, authenticate } = require("../middleware/auth");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../config/logger");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;
const { createNotification } = require("../services/notifications");
const { sendCampaignCommentEmail, sendCommentReplyEmail } = require("../services/emailService");

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, "")
    .trim();
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
      error: "Only the campaign creator can moderate comments",
    });
  }

  req.campaign = rows[0];
  next();
}
const commentRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req.ip),
  message: { error: "Rate limit exceeded. You can post up to 5 comments per minute." },
});


const COMMENT_COLUMNS = `cc.id, cc.campaign_id, cc.author_id, cc.author_id AS user_id, cc.parent_id, cc.body,
       cc.hidden, cc.hidden_reason, cc.created_at, cc.updated_at,
       cc.pinned,
       u.name AS author_name, (cc.author_id = c.creator_id) AS is_creator_reply`;

// Public (optionally authenticated): list comments newest first, flat with parent_id.
// Hidden comments are only visible to the campaign creator/admin.
router.get(
  "/:id/comments",
  asyncHandler(async (req, res) => {
    const { rows: campaigns } = await db.query(
      "SELECT id, creator_id FROM campaigns WHERE id = $1",
      [req.params.id],
    );
    if (!campaigns.length) return res.status(404).json({ error: "Campaign not found" });

    try {
      await authenticate(req);
    } catch {
      // anonymous viewer — proceed without req.user
    }

    const userId = req.user?.userId || null;
    const canSeeHidden =
      req.user && (req.user.userId === campaigns[0].creator_id || req.user.role === "admin");

    const limit = parseInt(req.query.limit, 10) || null;
    const page = parseInt(req.query.page, 10) || 1;
    const offset = limit ? (page - 1) * limit : null;

    let queryText = `SELECT ${COMMENT_COLUMNS},
              COALESCE(u_cnt.upvotes_count, 0)::int AS upvotes_count,
              COALESCE(u_user.user_upvoted, false) AS user_upvoted
       FROM campaign_comments cc
       JOIN campaigns c ON c.id = cc.campaign_id
       JOIN users u ON u.id = cc.author_id
       LEFT JOIN (
         SELECT comment_id, COUNT(*) AS upvotes_count
         FROM campaign_comment_upvotes
         GROUP BY comment_id
       ) u_cnt ON u_cnt.comment_id = cc.id
       LEFT JOIN (
         SELECT comment_id, true AS user_upvoted
         FROM campaign_comment_upvotes
         WHERE user_id = $2
       ) u_user ON u_user.comment_id = cc.id
       WHERE cc.campaign_id = $1 ${canSeeHidden ? "" : "AND cc.hidden = FALSE"}
       ORDER BY cc.pinned DESC, cc.created_at DESC`;

    const params = [req.params.id, userId];

    if (limit) {
      params.push(limit, offset);
      queryText += ` LIMIT $3 OFFSET $4`;
    }

    const { rows } = await db.query(queryText, params);

    res.json(rows);
  }),
);

// Any authenticated user: post a top-level comment or a reply
router.post(
  "/:id/comments",
  requireAuth,
  commentRateLimiter,
  asyncHandler(async (req, res) => {
    const body = cleanText(req.body.body);
    if (!body) return res.status(422).json({ error: "Body is required" });

    const { rows: campaigns } = await db.query(
      "SELECT id, creator_id, title FROM campaigns WHERE id = $1",
      [req.params.id],
    );
    if (!campaigns.length) return res.status(404).json({ error: "Campaign not found" });
    const campaign = campaigns[0];

    let parentComment = null;
    if (req.body.parent_id) {
      const { rows: parents } = await db.query(
        "SELECT id, author_id, campaign_id FROM campaign_comments WHERE id = $1",
        [req.body.parent_id],
      );
      if (!parents.length || parents[0].campaign_id !== campaign.id) {
        return res.status(422).json({ error: "Invalid parent_id" });
      }
      parentComment = parents[0];
    }

    const { rows } = await db.query(
      `INSERT INTO campaign_comments (campaign_id, author_id, parent_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, campaign_id, author_id, parent_id, body, hidden, hidden_reason, created_at, updated_at`,
      [req.params.id, req.user.userId, parentComment ? parentComment.id : null, body],
    );
    const { rows: authorRows } = await db.query("SELECT name FROM users WHERE id = $1", [
      req.user.userId,
    ]);

    const isCreatorReply = campaign.creator_id === req.user.userId;
    const comment = {
      ...rows[0],
      user_id: req.user.userId,
      author_name: authorRows[0]?.name,
      is_creator_reply: isCreatorReply,
      upvotes_count: 0,
      user_upvoted: false,
    };

    setImmediate(async () => {
      const excerpt = body.length > 160 ? `${body.slice(0, 160).trim()}…` : body;
      if (parentComment) {
        if (parentComment.author_id !== req.user.userId) {
          createNotification(parentComment.author_id, {
            type: "comment_reply",
            title: `New reply on "${campaign.title}"`,
            body: excerpt,
            link: `/campaigns/${campaign.id}`,
          }).catch((err) =>
            logger.error("Comment reply notification failed", { error: err.message }),
          );

          try {
            const { rows: parentUsers } = await db.query(
              "SELECT email, name FROM users WHERE id = $1",
              [parentComment.author_id],
            );
            if (parentUsers.length && parentUsers[0].email) {
              await sendCommentReplyEmail({
                to: parentUsers[0].email,
                commentId: comment.id,
                commenterName: parentUsers[0].name,
                replierName: authorRows[0]?.name,
                campaignTitle: campaign.title,
                campaignId: campaign.id,
                replyBody: body,
                isCreatorReply,
              });
            }
          } catch (err) {
            logger.error("Comment reply email notification failed", { error: err.message });
          }
        }
      } else if (campaign.creator_id !== req.user.userId) {
        createNotification(campaign.creator_id, {
          type: "campaign_comment",
          title: `New comment on "${campaign.title}"`,
          body: excerpt,
          link: `/campaigns/${campaign.id}`,
        }).catch((err) => logger.error("Comment notification failed", { error: err.message }));

        try {
          const { rows: creatorUsers } = await db.query(
            "SELECT email, name FROM users WHERE id = $1",
            [campaign.creator_id],
          );
          if (creatorUsers.length && creatorUsers[0].email) {
            await sendCampaignCommentEmail({
              to: creatorUsers[0].email,
              commentId: comment.id,
              creatorName: creatorUsers[0].name,
              commenterName: authorRows[0]?.name,
              campaignTitle: campaign.title,
              campaignId: campaign.id,
              commentBody: body,
            });
          }
        } catch (err) {
          logger.error("Campaign comment email notification failed", { error: err.message });
        }
      }
    });

    res.status(201).json(comment);
  }),
);

// Any authenticated user: upvote or un-upvote a comment
router.post(
  "/:id/comments/:commentId/upvote",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { commentId, id: campaignId } = req.params;
    const userId = req.user.userId;

    const { rows: comments } = await db.query(
      "SELECT id FROM campaign_comments WHERE id = $1 AND campaign_id = $2",
      [commentId, campaignId],
    );
    if (!comments.length) return res.status(404).json({ error: "Comment not found" });

    const { rows: existing } = await db.query(
      "SELECT 1 FROM campaign_comment_upvotes WHERE comment_id = $1 AND user_id = $2",
      [commentId, userId],
    );

    let upvoted = false;
    if (existing.length) {
      await db.query(
        "DELETE FROM campaign_comment_upvotes WHERE comment_id = $1 AND user_id = $2",
        [commentId, userId],
      );
      upvoted = false;
    } else {
      await db.query(
        "INSERT INTO campaign_comment_upvotes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [commentId, userId],
      );
      upvoted = true;
    }

    const { rows: countRows } = await db.query(
      "SELECT COUNT(*)::int AS upvotes_count FROM campaign_comment_upvotes WHERE comment_id = $1",
      [commentId],
    );

    res.json({ upvoted, upvotes_count: countRows[0].upvotes_count });
  }),
);

// Author only: edit own comment within 24 hours
router.patch(
  "/:id/comments/:commentId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = cleanText(req.body.body);
    if (!body) return res.status(422).json({ error: "Body is required" });

    const { rows } = await db.query(
      `UPDATE campaign_comments
       SET body = $1, updated_at = NOW()
       WHERE id = $2
         AND campaign_id = $3
         AND author_id = $4
         AND created_at >= NOW() - INTERVAL '24 hours'
       RETURNING id, campaign_id, author_id, parent_id, body, hidden, hidden_reason, created_at, updated_at`,
      [body, req.params.commentId, req.params.id, req.user.userId],
    );

    if (!rows.length) {
      return res.status(403).json({ error: "Comment not found or edit window has expired" });
    }

    res.json(rows[0]);
  }),
);

// Author (own comment) OR campaign creator/admin (moderation): delete a comment
router.delete(
  "/:id/comments/:commentId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: campaigns } = await db.query(
      "SELECT id, creator_id FROM campaigns WHERE id = $1",
      [req.params.id],
    );
    if (!campaigns.length) return res.status(404).json({ error: "Campaign not found" });

    const isModerator =
      campaigns[0].creator_id === req.user.userId || req.user.role === "admin";

    const { rowCount } = await db.query(
      `DELETE FROM campaign_comments
       WHERE id = $1
         AND campaign_id = $2
         ${isModerator ? "" : "AND author_id = $3"}`,
      isModerator
        ? [req.params.commentId, req.params.id]
        : [req.params.commentId, req.params.id, req.user.userId],
    );

    if (!rowCount) {
      return res.status(404).json({ error: "Comment not found" });
    }

    res.status(204).send();
  }),
);

// Any authenticated user: flag a comment for moderation review
router.post(
  "/:id/comments/:commentId/flag",
  requireAuth,
  asyncHandler(async (req, res) => {
    const reason = cleanText(req.body.reason || "");

    const { rows } = await db.query(
      "SELECT id FROM campaign_comments WHERE id = $1 AND campaign_id = $2",
      [req.params.commentId, req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: "Comment not found" });

    await db.query(
      `INSERT INTO campaign_comment_flags (comment_id, flagged_by, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (comment_id, flagged_by) DO NOTHING`,
      [req.params.commentId, req.user.userId, reason || null],
    );

    res.status(204).send();
  }),
);

// Creator/admin only: review queue of flagged and hidden comments
router.get(
  "/:id/comments/moderation",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT ${COMMENT_COLUMNS}, COALESCE(f.flag_count, 0)::int AS flag_count
       FROM campaign_comments cc
       JOIN campaigns c ON c.id = cc.campaign_id
       JOIN users u ON u.id = cc.author_id
       LEFT JOIN (
         SELECT comment_id, COUNT(*) AS flag_count
         FROM campaign_comment_flags
         GROUP BY comment_id
       ) f ON f.comment_id = cc.id
       WHERE cc.campaign_id = $1 AND (cc.hidden = TRUE OR COALESCE(f.flag_count, 0) > 0)
       ORDER BY flag_count DESC, cc.created_at DESC`,
      [req.params.id],
    );

    res.json(rows);
  }),
);

// Creator/admin only: hide a comment
router.post(
  "/:id/comments/:commentId/hide",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const reason = cleanText(req.body.reason || "");

    const { rows } = await db.query(
      `UPDATE campaign_comments
       SET hidden = TRUE, hidden_reason = $1, hidden_by = $2, hidden_at = NOW()
       WHERE id = $3 AND campaign_id = $4
       RETURNING id, campaign_id, author_id, parent_id, body, hidden, hidden_reason, created_at, updated_at`,
      [reason || null, req.user.userId, req.params.commentId, req.params.id],
    );

    if (!rows.length) return res.status(404).json({ error: "Comment not found" });
    res.json(rows[0]);
  }),
);

// Creator/admin only: unhide a comment
router.post(
  "/:id/comments/:commentId/unhide",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE campaign_comments
       SET hidden = FALSE, hidden_reason = NULL, hidden_by = NULL, hidden_at = NULL
       WHERE id = $1 AND campaign_id = $2
       RETURNING id, campaign_id, author_id, parent_id, body, hidden, hidden_reason, created_at, updated_at`,
      [req.params.commentId, req.params.id],
    );

    if (!rows.length) return res.status(404).json({ error: "Comment not found" });
    res.json(rows[0]);
  }),
);


// Creator/admin only: pin a comment to the top (max one per campaign)
router.post(
  "/:id/comments/:commentId/pin",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    await db.query(
      `UPDATE campaign_comments SET pinned = FALSE WHERE campaign_id = $1`,
      [req.params.id],
    );
    const { rows } = await db.query(
      `UPDATE campaign_comments
       SET pinned = TRUE
       WHERE id = $1 AND campaign_id = $2
       RETURNING id, campaign_id, author_id, parent_id, body, hidden, hidden_reason, created_at, updated_at, pinned`,
      [req.params.commentId, req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: "Comment not found" });
    res.json(rows[0]);
  }),
);

// Creator/admin only: unpin a comment
router.post(
  "/:id/comments/:commentId/unpin",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `UPDATE campaign_comments
       SET pinned = FALSE
       WHERE id = $1 AND campaign_id = $2
       RETURNING id, campaign_id, author_id, parent_id, body, hidden, hidden_reason, created_at, updated_at, pinned`,
      [req.params.commentId, req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: "Comment not found" });
    res.json(rows[0]);
  }),
);

module.exports = router;
