const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const requireCampaignCreator = asyncHandler(async (req, res, next) => {
  const { rows } = await db.query(
    'SELECT creator_id FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
  if (rows[0].creator_id !== req.user.userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the campaign creator can view activity' });
  }
  next();
});

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

router.get(
  '/:id/activity',
  requireAuth,
  requireCampaignCreator,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const { rows } = await db.query(
      `SELECT event_type, event_id, occurred_at, summary, details
     FROM (
       SELECT 'status' AS event_type, id::text AS event_id, created_at AS occurred_at,
              'Campaign status changed' AS summary,
              jsonb_build_object('from', previous_status, 'to', new_status) AS details
       FROM campaign_status_events WHERE campaign_id = $1
       UNION ALL
       SELECT 'update', id::text, created_at, title,
              jsonb_build_object('body', body)
       FROM campaign_updates
       WHERE campaign_id = $1 AND (status = 'published' OR status IS NULL)
       UNION ALL
       SELECT 'milestone', me.id::text, me.created_at, me.action,
              jsonb_build_object('milestone', m.title, 'note', me.note)
       FROM milestone_events me
       JOIN milestones m ON m.id = me.milestone_id
       WHERE m.campaign_id = $1
       UNION ALL
       SELECT 'contribution', id::text, created_at, 'Contribution received',
              jsonb_build_object('amount', amount, 'asset', asset)
       FROM contributions WHERE campaign_id = $1
     ) activity
     ORDER BY occurred_at DESC
     LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    if (req.query.format === 'csv') {
      const lines = [
        ['event_type', 'event_id', 'occurred_at', 'summary', 'details'].join(','),
        ...rows.map(row =>
          [
            row.event_type,
            row.event_id,
            row.occurred_at?.toISOString?.() || row.occurred_at,
            row.summary,
            JSON.stringify(row.details || {}),
          ]
            .map(csvCell)
            .join(',')
        ),
      ];
      res
        .type('text/csv')
        .attachment(`campaign-${req.params.id}-activity.csv`)
        .send(lines.join('\n'));
      return;
    }

    res.json({ data: rows, limit, offset });
  })
);

module.exports = router;
