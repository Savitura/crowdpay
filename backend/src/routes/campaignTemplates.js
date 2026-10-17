const router = require('express').Router();
const db = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const fields =
  'id, slug, name, category, description, template_data, is_active, use_count, created_at, updated_at';

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { rows } = await db.query(
      `SELECT ${fields} FROM campaign_templates WHERE is_active = TRUE ORDER BY name`
    );
    res.json(rows);
  })
);

router.use(requireAuth, requireAdmin);
router.get(
  '/admin',
  asyncHandler(async (_req, res) => {
    const { rows } = await db.query(`SELECT ${fields} FROM campaign_templates ORDER BY name`);
    res.json(rows);
  })
);
router.post(
  '/admin',
  asyncHandler(async (req, res) => {
    const { slug, name, category, description, template_data, is_active = true } = req.body;
    if (
      !slug ||
      !name ||
      !category ||
      !description ||
      !template_data ||
      typeof template_data !== 'object'
    )
      return res
        .status(400)
        .json({ error: 'slug, name, category, description, and template_data are required' });
    const { rows } = await db.query(
      `INSERT INTO campaign_templates (slug, name, category, description, template_data, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${fields}`,
      [slug, name, category, description, template_data, is_active]
    );
    res.status(201).json(rows[0]);
  })
);
router.patch(
  '/admin/:id',
  asyncHandler(async (req, res) => {
    const { name, category, description, template_data, is_active } = req.body;
    const { rows } = await db.query(
      `UPDATE campaign_templates SET name = COALESCE($1,name), category = COALESCE($2,category), description = COALESCE($3,description), template_data = COALESCE($4,template_data), is_active = COALESCE($5,is_active), updated_at = NOW() WHERE id = $6 RETURNING ${fields}`,
      [name, category, description, template_data, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json(rows[0]);
  })
);
router.delete(
  '/admin/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      'UPDATE campaign_templates SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Template not found' });
    res.status(204).send();
  })
);
module.exports = router;
