const express = require('express');
const { body, param } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { validateRequest } = require('../middleware/validation');
const asyncHandler = require('../utils/asyncHandler');
const db = require('../config/database');
const { resolveCampaignLanguage, SUPPORTED_LANGUAGES } = require('../utils/campaignLocale');

const router = express.Router();

const VALID_LANGUAGES = [...SUPPORTED_LANGUAGES];

const upsertValidation = [
  param('campaignId').isUUID().withMessage('Valid campaign ID is required'),
  body('locale')
    .optional()
    .custom(value => Boolean(resolveCampaignLanguage(value)))
    .withMessage(`Locale must resolve to one of: ${VALID_LANGUAGES.join(', ')}`),
  body('language')
    .optional()
    .custom(value => Boolean(resolveCampaignLanguage(value)))
    .withMessage(`Language must resolve to one of: ${VALID_LANGUAGES.join(', ')}`),
  body().custom(val => {
    const loc = val && (val.locale || val.language);
    if (!loc) {
      throw new Error('Either locale or language is required');
    }
    if (
      val.locale &&
      val.language &&
      resolveCampaignLanguage(val.locale) !== resolveCampaignLanguage(val.language)
    ) {
      throw new Error('Locale and language must match');
    }
    return true;
  }),
  body('title')
    .trim()
    .isLength({ min: 1, max: 255 })
    .withMessage('Title is required (max 255 chars)'),
  body('description').optional().trim(),
  body('milestone_titles')
    .optional()
    .custom(value => {
      let titles = value;
      if (typeof titles === 'string') {
        try {
          titles = JSON.parse(titles);
        } catch {
          throw new Error('Milestone titles must be valid JSON');
        }
      }
      if (
        !titles ||
        typeof titles !== 'object' ||
        (!Array.isArray(titles) && Object.getPrototypeOf(titles) !== Object.prototype)
      ) {
        throw new Error('Milestone titles must be an array or object');
      }
      const values = Array.isArray(titles) ? titles : Object.values(titles);
      if (
        values.length > 100 ||
        values.some(title => typeof title !== 'string' || title.length > 255)
      ) {
        throw new Error(
          'Milestone titles must contain at most 100 strings of 255 characters or fewer'
        );
      }
      return true;
    }),
];

// GET /:campaignId/translations — list all translations for a campaign
router.get(
  '/:campaignId/translations',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, campaign_id, language, COALESCE(locale, language) AS locale, title, description, milestone_titles, created_at, updated_at
       FROM campaign_translations
       WHERE campaign_id = $1
       ORDER BY COALESCE(locale, language)`,
      [req.params.campaignId]
    );
    res.json({ success: true, data: rows });
  })
);

// GET /:campaignId/translations/:locale — get specific translation
router.get(
  '/:campaignId/translations/:locale',
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const locale = resolveCampaignLanguage(req.params.locale);
    if (!locale)
      return res.status(400).json({ success: false, error: 'Unsupported campaign locale' });
    const { rows } = await db.query(
      `SELECT id, campaign_id, language, COALESCE(locale, language) AS locale, title, description, milestone_titles, created_at, updated_at
       FROM campaign_translations
       WHERE campaign_id = $1 AND (locale = $2 OR language = $2)
       LIMIT 1`,
      [campaignId, locale.toLowerCase()]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Translation not found' });
    }
    res.json({ success: true, data: rows[0] });
  })
);

// POST /:campaignId/translations — create or update a translation
router.post(
  '/:campaignId/translations',
  requireAuth,
  upsertValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const targetLocale = resolveCampaignLanguage(req.body.locale || req.body.language);
    const { title, description } = req.body;
    const userId = req.user.userId || req.user.id;

    // Verify user owns this campaign
    const { rows: campaigns } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    if (campaigns.length === 0)
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaigns[0].creator_id !== userId && !req.user.is_admin) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    let milestoneTitlesJson = '[]';
    if (req.body.milestone_titles !== undefined) {
      milestoneTitlesJson =
        typeof req.body.milestone_titles === 'string'
          ? req.body.milestone_titles
          : JSON.stringify(req.body.milestone_titles);
    }

    const { rows } = await db.query(
      `INSERT INTO campaign_translations (campaign_id, language, locale, title, description, milestone_titles)
       VALUES ($1, $2, $2, $3, $4, $5)
       ON CONFLICT (campaign_id, language)
       DO UPDATE SET
         locale = EXCLUDED.locale,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         milestone_titles = EXCLUDED.milestone_titles,
         updated_at = NOW()
       RETURNING id, campaign_id, language, COALESCE(locale, language) AS locale, title, description, milestone_titles, created_at, updated_at`,
      [campaignId, targetLocale, title, description || null, milestoneTitlesJson]
    );
    res.json({ success: true, data: rows[0] });
  })
);

// DELETE /:campaignId/translations/:locale — remove a translation
router.delete(
  '/:campaignId/translations/:locale',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const locale = resolveCampaignLanguage(req.params.locale);
    if (!locale)
      return res.status(400).json({ success: false, error: 'Unsupported campaign locale' });
    const userId = req.user.userId || req.user.id;

    const { rows: campaigns } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    if (campaigns.length === 0)
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaigns[0].creator_id !== userId && !req.user.is_admin) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await db.query(
      'DELETE FROM campaign_translations WHERE campaign_id = $1 AND (locale = $2 OR language = $2)',
      [campaignId, locale.toLowerCase()]
    );
    res.json({ success: true });
  })
);

module.exports = router;
