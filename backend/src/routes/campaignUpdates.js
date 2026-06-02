const router = require("express").Router();
const db = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../utils/asyncHandler");

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, "")
    .trim();
}

async function requireCampaignCreator(req, res, next) {
  const campaignId = req.params.id;

  const { rows } = await db.query(
    "SELECT id, creator_id FROM campaigns WHERE id = $1",
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

    if (!title) return res.status(422).json({ error: "Title is required" });
    if (!body) return res.status(422).json({ error: "Body is required" });

    const { rows } = await db.query(
      `INSERT INTO campaign_updates (campaign_id, author_id, title, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, campaign_id, author_id, title, body, created_at, updated_at`,
      [req.params.id, req.user.userId, title, body],
    );

    res.status(201).json(rows[0]);
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

    if (!title) return res.status(422).json({ error: "Title is required" });
    if (!body) return res.status(422).json({ error: "Body is required" });

    const { rows } = await db.query(
      `UPDATE campaign_updates
       SET title = $1,
           body = $2,
           updated_at = NOW()
       WHERE id = $3
         AND campaign_id = $4
         AND author_id = $5
         AND created_at >= NOW() - INTERVAL '24 hours'
       RETURNING id, campaign_id, author_id, title, body, created_at, updated_at`,
      [title, body, req.params.updateId, req.params.id, req.user.userId],
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
