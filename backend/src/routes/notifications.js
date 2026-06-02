const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, type, title, body, link, read_at, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.user.userId]
  );
  res.json(rows);
});

router.patch('/read-all', requireAuth, async (req, res) => {
  await db.query(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
    [req.user.userId]
  );
  res.json({ ok: true });
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

module.exports = router;
