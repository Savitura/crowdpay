const db = require('../config/database');
const logger = require('../config/logger');

const VALID_REASONS = ['non_delivery', 'misrepresentation', 'abandoned', 'other'];
const VALID_STATUSES = [
  'open',
  'under_review',
  'resolved_creator',
  'resolved_contributor',
  'closed',
];

async function logDisputeEvent(q, { disputeId, actorId, action, note }) {
  await q.query(
    `INSERT INTO dispute_events (dispute_id, actor_id, action, note)
     VALUES ($1, $2, $3, $4)`,
    [disputeId, actorId || null, action, note || null]
  );
}

async function createDispute({
  campaignId,
  userId,
  reason,
  description,
  evidenceUrl = null,
  milestoneId = null,
}) {
  if (!VALID_REASONS.includes(reason)) {
    const err = new Error(`reason must be one of: ${VALID_REASONS.join(', ')}`);
    err.status = 422;
    throw err;
  }
  if (!description || !description.trim()) {
    const err = new Error('description is required');
    err.status = 422;
    throw err;
  }

  const { rows: campaigns } = await db.query(
    'SELECT id, creator_id, title, wallet_public_key FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaigns.length) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  const campaign = campaigns[0];

  const { rows: contributions } = await db.query(
    `SELECT id FROM contributions
     WHERE campaign_id = $1 AND sender_public_key = (
       SELECT wallet_public_key FROM users WHERE id = $2
     ) LIMIT 1`,
    [campaign.id, userId]
  );
  if (!contributions.length) {
    const err = new Error('Only contributors who have backed this campaign can raise a dispute');
    err.status = 403;
    err.code = 'NOT_A_CONTRIBUTOR';
    throw err;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (milestoneId) {
      const { rows: milestoneRows } = await client.query(
        'SELECT id FROM milestones WHERE id = $1 AND campaign_id = $2',
        [milestoneId, campaign.id]
      );
      if (!milestoneRows.length) {
        await client.query('ROLLBACK');
        const err = new Error('milestone_id does not belong to this campaign');
        err.status = 422;
        throw err;
      }
    }

    const { rows } = await client.query(
      `INSERT INTO disputes (campaign_id, raised_by, reason, description, evidence_url, milestone_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [campaign.id, userId, reason, description.trim(), evidenceUrl || null, milestoneId || null]
    );
    const dispute = rows[0];

    await logDisputeEvent(client, {
      disputeId: dispute.id,
      actorId: userId,
      action: 'raised',
      note: reason,
    });

    await client.query('COMMIT');
    return dispute;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listCampaignDisputes(campaignId, { limit = 20, offset = 0, db: customDb } = {}) {
  const activeDb = customDb || db;
  const countResult = await activeDb.query(
    'SELECT COUNT(*)::int AS total FROM disputes WHERE campaign_id = $1',
    [campaignId]
  );
  const total = countResult.rows[0]?.total || 0;

  const { rows } = await activeDb.query(
    `SELECT d.*, u.name AS raised_by_name, u.email AS raised_by_email
     FROM disputes d
     JOIN users u ON u.id = d.raised_by
     WHERE d.campaign_id = $1
     ORDER BY d.created_at DESC
     LIMIT $2 OFFSET $3`,
    [campaignId, limit, offset]
  );
  return { data: rows, total, limit, offset };
}

async function getActiveCampaignDispute(campaignId, userId, { db: customDb } = {}) {
  const activeDb = customDb || db;
  const { rows } = await activeDb.query(
    `SELECT d.*, c.creator_id
     FROM disputes d
     JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.campaign_id = $1 AND d.status IN ('open', 'under_review')
     ORDER BY d.created_at DESC
     LIMIT 1`,
    [campaignId]
  );
  if (!rows.length) return null;

  const dispute = rows[0];
  if (userId !== dispute.raised_by && userId !== dispute.creator_id) {
    return null;
  }
  return dispute;
}

async function submitEvidence(
  { disputeId, userId, text, attachmentUrls = [] },
  { db: customDb, logger: customLogger } = {}
) {
  const activeDb = customDb || db;
  const activeLogger = customLogger || logger;
  if (!text || !text.trim()) {
    const err = new Error('text is required');
    err.status = 422;
    throw err;
  }

  const { rows: disputes } = await activeDb.query(
    `SELECT d.*, c.creator_id
     FROM disputes d JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.id = $1`,
    [disputeId]
  );
  if (!disputes.length) {
    const err = new Error('Dispute not found');
    err.status = 404;
    throw err;
  }
  const dispute = disputes[0];

  let role;
  if (userId === dispute.raised_by) {
    role = 'contributor';
  } else if (userId === dispute.creator_id) {
    role = 'creator';
  } else {
    const err = new Error(
      'Only the disputing contributor or the campaign creator can submit evidence'
    );
    err.status = 403;
    throw err;
  }

  const urls = Array.isArray(attachmentUrls) ? attachmentUrls : [];
  const { rows } = await activeDb.query(
    `INSERT INTO dispute_evidence (dispute_id, submitted_by, role, text, attachment_urls)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [dispute.id, userId, role, text.trim(), JSON.stringify(urls)]
  );

  await logDisputeEvent(activeDb, {
    disputeId: dispute.id,
    actorId: userId,
    action: 'evidence_submitted',
    note: role,
  }).catch(err => activeLogger.error('Dispute evidence log failed', { error: err.message }));

  return rows[0];
}

async function updateDisputeStatus(
  { disputeId, actorId, status, resolutionNote = null },
  { db: customDb, logger: customLogger } = {}
) {
  const activeDb = customDb || db;
  const activeLogger = customLogger || logger;
  if (!VALID_STATUSES.includes(status)) {
    const err = new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    err.status = 422;
    throw err;
  }

  const { rows: existing } = await activeDb.query('SELECT * FROM disputes WHERE id = $1', [
    disputeId,
  ]);
  if (!existing.length) {
    const err = new Error('Dispute not found');
    err.status = 404;
    throw err;
  }

  const isResolved =
    status === 'resolved_creator' || status === 'resolved_contributor' || status === 'closed';
  const resolvedAt = isResolved ? new Date() : null;

  const { rows } = await activeDb.query(
    `UPDATE disputes
     SET status = $1,
         resolution_note = COALESCE($2, resolution_note),
         resolved_at = CASE WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz ELSE resolved_at END,
         updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [status, resolutionNote, resolvedAt, disputeId]
  );

  await logDisputeEvent(activeDb, {
    disputeId,
    actorId,
    action: 'status_updated',
    note: `${status}${resolutionNote ? ': ' + resolutionNote : ''}`,
  }).catch(err => activeLogger.error('Dispute status log failed', { error: err.message }));

  return rows[0];
}

module.exports = {
  logDisputeEvent,
  createDispute,
  listCampaignDisputes,
  getActiveCampaignDispute,
  submitEvidence,
  updateDisputeStatus,
  VALID_REASONS,
  VALID_STATUSES,
};
