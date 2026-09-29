const router = require("express").Router();
const db = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../utils/asyncHandler");
const logger = require("../config/logger");
const {
  sendCampaignUpdateNotifications,
} = require("../services/campaignUpdatesPublishing");
const {
  CAMPAIGN_UPDATE_BODY_MAX_LENGTH,
} = require("../middleware/validation");

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

// Public: list published updates newest first
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
            cu.status,
            cu.scheduled_for,
            cu.created_at,
            cu.updated_at,
            u.name AS author_name
     FROM campaign_updates cu
     JOIN users u ON u.id = cu.author_id
     WHERE cu.campaign_id = $1
       AND (cu.status = 'published' OR cu.status IS NULL)
     ORDER BY cu.created_at DESC`,
      [req.params.id],
    );

    res.json(rows);
  }),
);

// Creator only: create update (immediate or scheduled)
router.post(
  "/:id/updates",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const title = cleanText(req.body.title);
    const body = cleanText(req.body.body);
    const rawScheduledFor = req.body.scheduled_for;
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

    let status = 'published';
    let scheduledFor = null;

    if (rawScheduledFor) {
      const scheduledDate = new Date(rawScheduledFor);
      if (isNaN(scheduledDate.getTime())) {
        return res.status(422).json({ error: "Invalid scheduled_for date format" });
      }
      if (scheduledDate.getTime() <= Date.now()) {
        return res.status(422).json({ error: "scheduled_for must be in the future" });
      }
      scheduledFor = scheduledDate.toISOString();
      status = 'scheduled';
    }

    const { rows } = await db.query(
      `INSERT INTO campaign_updates (campaign_id, author_id, title, body, attachments, status, scheduled_for)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING id, campaign_id, author_id, title, body, attachments, status, scheduled_for, created_at, updated_at`,
      [req.params.id, req.user.userId, title, body, attachmentsJson, status, scheduledFor],
    );
    const update = rows[0];

    // Only send notifications immediately if not scheduled for the future
    if (status === 'published') {
      setImmediate(() => {
        sendCampaignUpdateNotifications({
          campaignId: req.params.id,
          campaignTitle: req.campaign.title,
          update,
          authorId: req.user.userId,
        }).catch((err) => {
          logger.error("Failed to send update notifications", { error: err.message });
        });
      });
    }

    res.status(201).json(update);
  }),
);

// Creator only: edit or reschedule update
router.patch(
  "/:id/updates/:updateId",
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const title = cleanText(req.body.title);
    const body = cleanText(req.body.body);
    const rawScheduledFor = req.body.scheduled_for;
    let attachmentsJson;

    if (req.body.attachments !== undefined) {
      try {
        attachmentsJson = validateAttachments(req.body.attachments);
      } catch (err) {
        return res.status(err.statusCode || 422).json({ error: err.message });
      }
    }

    if (req.body.title !== undefined && !title) {
      return res.status(422).json({ error: "Title is required" });
    }
    if (req.body.body !== undefined && !body) {
      return res.status(422).json({ error: "Body is required" });
    }
    if (body && body.length > CAMPAIGN_UPDATE_BODY_MAX_LENGTH) {
      return res.status(422).json({
        error: `Update body must be ${CAMPAIGN_UPDATE_BODY_MAX_LENGTH} characters or fewer`,
      });
    }

    // Check existing update record
    const { rows: existingRows } = await db.query(
      `SELECT id, campaign_id, author_id, title, body, attachments, status, scheduled_for, created_at
       FROM campaign_updates
       WHERE id = $1 AND campaign_id = $2 AND author_id = $3`,
      [req.params.updateId, req.params.id, req.user.userId]
    );

    if (!existingRows.length) {
      return res.status(404).json({ error: "Update not found" });
    }

    const existing = existingRows[0];
    const isScheduled = existing.status === 'scheduled';

    if (!isScheduled) {
      // 24h edit window check for published updates
      const createdAtTime = new Date(existing.created_at).getTime();
      const now = Date.now();
      if (now - createdAtTime > 24 * 60 * 60 * 1000) {
        return res.status(403).json({
          error: "Update edit window has expired",
        });
      }
      if (rawScheduledFor !== undefined) {
        return res.status(422).json({
          error: "Cannot set scheduled_for on an already published update",
        });
      }
    }

    let newScheduledFor = existing.scheduled_for;
    let newStatus = existing.status;

    if (isScheduled && rawScheduledFor !== undefined) {
      if (rawScheduledFor === null) {
        // Publish immediately
        newScheduledFor = null;
        newStatus = 'published';
      } else {
        const scheduledDate = new Date(rawScheduledFor);
        if (isNaN(scheduledDate.getTime())) {
          return res.status(422).json({ error: "Invalid scheduled_for date format" });
        }
        if (scheduledDate.getTime() <= Date.now()) {
          return res.status(422).json({ error: "scheduled_for must be in the future" });
        }
        newScheduledFor = scheduledDate.toISOString();
      }
    }

    const finalTitle = title || existing.title;
    const finalBody = body || existing.body;
    const finalAttachments = attachmentsJson !== undefined ? attachmentsJson : JSON.stringify(existing.attachments || []);

    const { rows } = await db.query(
      `UPDATE campaign_updates
       SET title = $1,
           body = $2,
           attachments = $3::jsonb,
           status = $4,
           scheduled_for = $5,
           updated_at = NOW()
       WHERE id = $6
         AND campaign_id = $7
         AND author_id = $8
       RETURNING id, campaign_id, author_id, title, body, attachments, status, scheduled_for, created_at, updated_at`,
      [finalTitle, finalBody, finalAttachments, newStatus, newScheduledFor, req.params.updateId, req.params.id, req.user.userId],
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Update not found" });
    }

    const updatedUpdate = rows[0];

    // If rescheduled to publish immediately, fire notifications
    if (isScheduled && newStatus === 'published') {
      setImmediate(() => {
        sendCampaignUpdateNotifications({
          campaignId: req.params.id,
          campaignTitle: req.campaign.title,
          update: updatedUpdate,
          authorId: req.user.userId,
        }).catch(() => {});
      });
    }

    res.json(updatedUpdate);
  }),
);

// Creator only: delete / cancel update
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
