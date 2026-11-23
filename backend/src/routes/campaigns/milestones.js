// backend/src/routes/campaigns/milestones.js
'use strict';

const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const withTransaction = require('../../utils/withTransaction');
const { stripHtml } = require('../../lib/sanitize');
const { resolveCampaignLanguage } = require('../../utils/campaignLocale');

function createMilestonesRouter(deps = {}) {
  const router = express.Router();
  const db = deps.db || require('../../config/database');
  const logger = deps.logger || require('../../config/logger');
  const auth = deps.auth || require('../../middleware/auth');
  const helpers = deps.helpers || require('./helpers')(deps);

  const { requireAuth } = auth;

  const BUDGET_CATEGORY_COLUMNS =
    'id, campaign_id, title, amount, description, created_at, updated_at';

  const MILESTONE_COLUMNS = [
    'id',
    'campaign_id',
    'title',
    'description',
    'release_percentage',
    'sort_order',
    'evidence_url',
    'evidence_description',
    'evidence_submitted_at',
    'destination_key',
    'review_note',
    'reviewer_id',
    'reviewed_at',
    'status',
    'created_at',
    'completed_at',
    'approved_at',
    'released_at',
    'claimed_at',
    'contract_index',
    'auto_release_enabled',
    'auto_release_rule',
    'auto_release_rule_config',
    'auto_release_window_seconds',
    'auto_release_status',
    'auto_release_configured_at',
    'auto_release_scheduled_at',
    'auto_release_at',
    'auto_release_evidence_url',
    'auto_release_evidence_sha256',
    'auto_release_halted_at',
    'auto_release_halt_reason',
    'auto_release_dispute_id',
    'release_trigger',
  ].map(c => `m.${c}`).join(', ');
  const { requireCampaignMember, normalizeMilestonesInput } = helpers;

  router.get(
    '/:id/milestones',
    asyncHandler(async (req, res) => {
      const rawLocale = req.query.locale || req.query.lang;
      const requestedLocale = rawLocale ? resolveCampaignLanguage(rawLocale) : null;
      if (rawLocale && !requestedLocale) {
        return res.status(400).json({ error: 'Unsupported campaign locale' });
      }

      const { rows } = await db.query(
        `SELECT ${MILESTONE_COLUMNS}, (c.milestones_contract_id IS NOT NULL) AS on_chain
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.campaign_id = $1
     ORDER BY m.sort_order ASC, m.created_at ASC`,
        [req.params.id]
      );

      if (requestedLocale && rows.length > 0) {
        try {
          const { rows: transRows } = await db.query(
            `SELECT milestone_titles
         FROM campaign_translations
         WHERE campaign_id = $1 AND (locale = $2 OR language = $2)
         LIMIT 1`,
            [req.params.id, requestedLocale]
          );
          if (transRows.length > 0 && transRows[0].milestone_titles) {
            let mt = transRows[0].milestone_titles;
            if (typeof mt === 'string') {
              try {
                mt = JSON.parse(mt);
              } catch {
                mt = [];
              }
            }
            rows.forEach((milestone, idx) => {
              if (Array.isArray(mt)) {
                if (mt[idx]) milestone.title = mt[idx];
              } else if (typeof mt === 'object' && mt !== null) {
                if (mt[milestone.id]) milestone.title = mt[milestone.id];
                else if (mt[idx]) milestone.title = mt[idx];
              }
            });
          }
        } catch (err) {
          logger.warn('Failed to load milestone translations', {
            campaign_id: req.params.id,
            locale: requestedLocale,
            error: err.message,
          });
        }
      }

      res.json(rows);
    })
  );

  router.post(
    '/:id/milestones',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      let normalizedMilestones;
      try {
        normalizedMilestones = normalizeMilestonesInput(req.body?.milestones);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      if (!normalizedMilestones.length) {
        return res.status(400).json({ error: 'At least one milestone is required' });
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const { rows: campaignRows } = await client.query(
          'SELECT id, creator_id, status FROM campaigns WHERE id = $1 FOR UPDATE',
          [req.params.id]
        );
        if (!campaignRows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Campaign not found' });
        }
        const campaign = campaignRows[0];
        if (campaign.creator_id !== req.user.userId) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Only the campaign creator can define milestones' });
        }
        if (!['active', 'funded', 'in_progress'].includes(campaign.status)) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `Milestones cannot be edited while campaign status is "${campaign.status}".`,
          });
        }

        const { rows: existingRows } = await client.query(
          'SELECT status FROM milestones WHERE campaign_id = $1',
          [campaign.id]
        );
        if (existingRows.some(row => row.status !== 'pending')) {
          await client.query('ROLLBACK');
          return res
            .status(409)
            .json({ error: 'Milestone plan cannot be changed after approvals or releases begin' });
        }

        await client.query('DELETE FROM milestones WHERE campaign_id = $1', [campaign.id]);
        const inserted = [];
        for (const milestone of normalizedMilestones) {
          const { rows } = await client.query(
            `INSERT INTO milestones
           (campaign_id, title, description, release_percentage, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
            [
              campaign.id,
              milestone.title,
              milestone.description,
              milestone.release_percentage,
              milestone.sort_order,
            ]
          );
          inserted.push(rows[0]);
        }
        await client.query('COMMIT');
        res.status(201).json(inserted);
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Campaign milestone plan update failed', {
          campaign_id: req.params.id,
          error: err.message,
        });
        res.status(500).json({ error: 'Could not save campaign milestones' });
      } finally {
        client.release();
      }
    })
  );

  router.get(
    '/:id/budgets',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `SELECT ${BUDGET_CATEGORY_COLUMNS} FROM campaign_budget_categories WHERE campaign_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      );
      res.json(rows);
    })
  );

  router.post(
    '/:id/budgets',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { budgets } = req.body;

      if (!Array.isArray(budgets)) {
        return res.status(400).json({ error: 'budgets must be an array' });
      }

      try {
        const inserted = await withTransaction(async client => {
          const { rows: campaignRows } = await client.query(
            `SELECT target_amount FROM campaigns WHERE id = $1 FOR UPDATE`,
            [req.params.id]
          );
          if (!campaignRows.length) throw new Error('Campaign not found');

          const totalBudget = budgets.reduce((sum, b) => sum + Number(b.amount), 0);
          if (
            budgets.length > 0 &&
            Math.abs(totalBudget - Number(campaignRows[0].target_amount)) > 0.0001
          ) {
            throw new Error(
              `Total budget (${totalBudget}) must match campaign target amount (${campaignRows[0].target_amount})`
            );
          }

          await client.query(`DELETE FROM campaign_budget_categories WHERE campaign_id = $1`, [
            req.params.id,
          ]);

          const inserted = [];
          if (budgets.length > 0) {
            for (const b of budgets) {
              if (!b.title || !b.amount || Number(b.amount) <= 0) {
                throw new Error('Invalid budget item');
              }
              const { rows } = await client.query(
                `INSERT INTO campaign_budget_categories (campaign_id, title, amount, description) VALUES ($1, $2, $3, $4) RETURNING *`,
                [req.params.id, b.title, Number(b.amount), b.description || null]
              );
              inserted.push(rows[0]);
            }
          }
          return inserted;
        }, db);
        res.status(201).json(inserted);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    })
  );

  router.get(
    '/:id/stretch-goals',
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `SELECT id, title, description, amount, sort_order, created_at
     FROM campaign_stretch_goals
     WHERE campaign_id = $1
     ORDER BY sort_order ASC, amount ASC`,
        [req.params.id]
      );
      res.json(rows);
    })
  );

  // POST /campaigns/:id/stretch-goals - owner only

  router.post(
    '/:id/stretch-goals',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { title, description, amount, sort_order } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }
      const { rows } = await db.query(
        `INSERT INTO campaign_stretch_goals (campaign_id, title, description, amount, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, description, amount, sort_order, created_at`,
        [req.params.id, title.trim(), description?.trim() || null, Number(amount), sort_order ?? 0]
      );
      res.status(201).json(rows[0]);
    })
  );

  // PATCH /campaigns/:id/stretch-goals/:goalId - owner only

  router.patch(
    '/:id/stretch-goals/:goalId',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { title, description, amount, sort_order } = req.body;
      const updates = [];
      const values = [];
      let idx = 1;
      if (title !== undefined) {
        updates.push(`title = $${idx++}`);
        values.push(title.trim());
      }
      if (description !== undefined) {
        updates.push(`description = $${idx++}`);
        values.push(description?.trim() || null);
      }
      if (amount !== undefined) {
        if (isNaN(Number(amount)) || Number(amount) <= 0)
          return res.status(400).json({ error: 'amount must be positive' });
        updates.push(`amount = $${idx++}`);
        values.push(Number(amount));
      }
      if (sort_order !== undefined) {
        updates.push(`sort_order = $${idx++}`);
        values.push(sort_order);
      }
      if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
      updates.push(`updated_at = NOW()`);
      values.push(req.params.goalId, req.params.id);
      const { rows } = await db.query(
        `UPDATE campaign_stretch_goals SET ${updates.join(', ')}
     WHERE id = $${idx} AND campaign_id = $${idx + 1}
     RETURNING id, title, description, amount, sort_order`,
        values
      );
      if (!rows.length) return res.status(404).json({ error: 'Stretch goal not found' });
      res.json(rows[0]);
    })
  );

  // DELETE /campaigns/:id/stretch-goals/:goalId - owner only

  router.delete(
    '/:id/stretch-goals/:goalId',
    requireAuth,
    requireCampaignMember('owner'),
    asyncHandler(async (req, res) => {
      const { rows } = await db.query(
        `DELETE FROM campaign_stretch_goals WHERE id = $1 AND campaign_id = $2 RETURNING id`,
        [req.params.goalId, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Stretch goal not found' });
      res.status(204).end();
    })
  );

  // ── Campaign Report Export (PDF) ──────────────────────────────────────────────

  // Download a PDF report for the campaign (owner or admin only)

  return router;
}

module.exports = createMilestonesRouter;
module.exports.createMilestonesRouter = createMilestonesRouter;
