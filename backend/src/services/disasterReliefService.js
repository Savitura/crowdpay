const db = require('../config/database');
const logger = require('../config/logger');
const { createNotification } = require('./notifications');
const { logAuditEvent } = require('./auditService');

// Disaster-relief campaign mode with rapid verification workflow.
//
// Lifecycle:
//   draft -> pending_review -> verified | changes_requested | rejected
//   changes_requested -> pending_review
//   verified -> revoked
//
// Every state transition uses a compare-and-set `UPDATE ... WHERE status = $expected`
// so concurrent callers cannot double-transition, double-audit, or double-notify.

const DISASTER_TYPES = [
  'flood',
  'earthquake',
  'wildfire',
  'hurricane',
  'drought',
  'conflict',
  'epidemic',
  'industrial',
  'other',
];

const SEVERITY_LEVELS = ['watch', 'urgent', 'critical', 'catastrophic'];

const EVIDENCE_TYPES = [
  'government_notice',
  'media_report',
  'ngo_registration',
  'field_assessment',
  'logistics_plan',
  'other',
];

const VERIFICATION_STATUSES = [
  'draft',
  'pending_review',
  'verified',
  'changes_requested',
  'rejected',
  'revoked',
];

const ELIGIBLE_CAMPAIGN_STATUSES = ['draft', 'active', 'funded', 'in_progress'];

const RAPID_VERIFICATION_SLA_HOURS = 4;
const MAX_INCIDENT_NAME_LENGTH = 160;
const MAX_REGION_LENGTH = 200;
const MAX_RESPONDER_ORG_LENGTH = 200;
const MAX_EMERGENCY_CONTACT_LENGTH = 200;
const MAX_BADGE_LENGTH = 120;
const MAX_REVIEW_NOTE_LENGTH = 1000;
const MAX_EVIDENCE_ITEMS = 10;
const MAX_EVIDENCE_TITLE_LENGTH = 140;
const MAX_EVIDENCE_ISSUER_LENGTH = 140;
const MAX_EVIDENCE_URL_LENGTH = 500;
const MAX_AFFECTED_POPULATION = 100_000_000;

const TRANSITIONS = {
  draft: ['pending_review'],
  pending_review: ['verified', 'changes_requested', 'rejected'],
  changes_requested: ['pending_review'],
  verified: ['revoked'],
  rejected: [],
  revoked: [],
};

function domainError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value, index) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `ev_${index + 1}`;
}

function isValidHttpsEvidenceUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EVIDENCE_URL_LENGTH) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates and normalizes `evidence_items`.
 */
function validateEvidenceItems(raw = []) {
  if (raw === undefined || raw === null) {
    return { ok: true, evidenceItems: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      status: 422,
      field: 'evidence_items',
      error: 'evidence_items must be an array',
    };
  }
  if (raw.length > MAX_EVIDENCE_ITEMS) {
    return {
      ok: false,
      status: 422,
      field: 'evidence_items',
      error: `evidence_items may contain at most ${MAX_EVIDENCE_ITEMS} items`,
    };
  }

  const usedIds = new Set();
  const normalized = [];

  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') {
      return {
        ok: false,
        status: 422,
        field: `evidence_items[${index}]`,
        error: 'each evidence item must be an object',
      };
    }

    const title = cleanText(item.title);
    if (!title) {
      return {
        ok: false,
        status: 422,
        field: `evidence_items[${index}].title`,
        error: 'every evidence item requires a title',
      };
    }
    if (title.length > MAX_EVIDENCE_TITLE_LENGTH) {
      return {
        ok: false,
        status: 422,
        field: `evidence_items[${index}].title`,
        error: `evidence item title must be at most ${MAX_EVIDENCE_TITLE_LENGTH} characters`,
      };
    }

    const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() : 'other';
    if (!EVIDENCE_TYPES.includes(type)) {
      return {
        ok: false,
        status: 422,
        field: `evidence_items[${index}].type`,
        error: `evidence item type must be one of: ${EVIDENCE_TYPES.join(', ')}`,
      };
    }

    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!isValidHttpsEvidenceUrl(url)) {
      return {
        ok: false,
        status: 422,
        field: `evidence_items[${index}].url`,
        error: 'every evidence item requires a valid public https:// URL',
      };
    }

    const issuer = cleanText(item.issuer) || null;
    if (issuer && issuer.length > MAX_EVIDENCE_ISSUER_LENGTH) {
      return {
        ok: false,
        status: 422,
        field: `evidence_items[${index}].issuer`,
        error: `evidence item issuer must be at most ${MAX_EVIDENCE_ISSUER_LENGTH} characters`,
      };
    }

    let id =
      typeof item.id === 'string' && item.id.trim()
        ? slugify(item.id, index)
        : slugify(title, index);
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}_${suffix}`)) suffix += 1;
      id = `${id}_${suffix}`;
    }
    usedIds.add(id);

    normalized.push({ id, title, type, url, issuer });
  }

  return { ok: true, evidenceItems: normalized };
}

/**
 * Validates and normalizes a disaster-relief dossier payload.
 */
function validateDossierInput(input = {}) {
  if (!input || typeof input !== 'object') {
    return { ok: false, status: 422, error: 'dossier payload must be an object' };
  }

  const incidentName = cleanText(input.incident_name);
  if (!incidentName) {
    return {
      ok: false,
      status: 422,
      field: 'incident_name',
      error: 'incident_name is required',
    };
  }
  if (incidentName.length > MAX_INCIDENT_NAME_LENGTH) {
    return {
      ok: false,
      status: 422,
      field: 'incident_name',
      error: `incident_name must be at most ${MAX_INCIDENT_NAME_LENGTH} characters`,
    };
  }

  const disasterType =
    typeof input.disaster_type === 'string' ? input.disaster_type.trim().toLowerCase() : '';
  if (!DISASTER_TYPES.includes(disasterType)) {
    return {
      ok: false,
      status: 422,
      field: 'disaster_type',
      error: `disaster_type must be one of: ${DISASTER_TYPES.join(', ')}`,
    };
  }

  const severityLevel =
    typeof input.severity_level === 'string' ? input.severity_level.trim().toLowerCase() : 'urgent';
  if (!SEVERITY_LEVELS.includes(severityLevel)) {
    return {
      ok: false,
      status: 422,
      field: 'severity_level',
      error: `severity_level must be one of: ${SEVERITY_LEVELS.join(', ')}`,
    };
  }

  const affectedRegion = cleanText(input.affected_region);
  if (!affectedRegion) {
    return {
      ok: false,
      status: 422,
      field: 'affected_region',
      error: 'affected_region is required',
    };
  }
  if (affectedRegion.length > MAX_REGION_LENGTH) {
    return {
      ok: false,
      status: 422,
      field: 'affected_region',
      error: `affected_region must be at most ${MAX_REGION_LENGTH} characters`,
    };
  }

  let affectedPopulation = null;
  if (
    input.affected_population !== undefined &&
    input.affected_population !== null &&
    input.affected_population !== ''
  ) {
    const rawPop = input.affected_population;
    const isNumericSource =
      typeof rawPop === 'number' || (typeof rawPop === 'string' && /^\d+$/.test(rawPop.trim()));
    const parsedPop = isNumericSource ? Number(rawPop) : NaN;
    if (!Number.isInteger(parsedPop) || parsedPop <= 0 || parsedPop > MAX_AFFECTED_POPULATION) {
      return {
        ok: false,
        status: 422,
        field: 'affected_population',
        error: `affected_population must be a positive integer up to ${MAX_AFFECTED_POPULATION}`,
      };
    }
    affectedPopulation = parsedPop;
  }

  const responderOrganization = cleanText(input.responder_organization) || null;
  if (responderOrganization && responderOrganization.length > MAX_RESPONDER_ORG_LENGTH) {
    return {
      ok: false,
      status: 422,
      field: 'responder_organization',
      error: `responder_organization must be at most ${MAX_RESPONDER_ORG_LENGTH} characters`,
    };
  }

  const emergencyContact = cleanText(input.emergency_contact) || null;
  if (emergencyContact && emergencyContact.length > MAX_EMERGENCY_CONTACT_LENGTH) {
    return {
      ok: false,
      status: 422,
      field: 'emergency_contact',
      error: `emergency_contact must be at most ${MAX_EMERGENCY_CONTACT_LENGTH} characters`,
    };
  }

  const evidenceCheck = validateEvidenceItems(input.evidence_items ?? []);
  if (!evidenceCheck.ok) return evidenceCheck;

  return {
    ok: true,
    dossier: {
      incident_name: incidentName,
      disaster_type: disasterType,
      severity_level: severityLevel,
      affected_region: affectedRegion,
      affected_population: affectedPopulation,
      responder_organization: responderOrganization,
      emergency_contact: emergencyContact,
      evidence_items: evidenceCheck.evidenceItems,
    },
  };
}

/**
 * Computes SLA telemetry for rapid verification (`pending_review` state).
 */
function computeSlaMetrics(row, now = new Date()) {
  if (!row || row.status !== 'pending_review' || !row.submitted_at) {
    return null;
  }
  const submittedMs = new Date(row.submitted_at).getTime();
  if (Number.isNaN(submittedMs)) return null;
  const targetMs = RAPID_VERIFICATION_SLA_HOURS * 60 * 60 * 1000;
  const dueMs = submittedMs + targetMs;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const remainingMs = dueMs - nowMs;

  return {
    target_hours: RAPID_VERIFICATION_SLA_HOURS,
    due_at: new Date(dueMs).toISOString(),
    remaining_ms: remainingMs,
    is_overdue: remainingMs < 0,
  };
}

/**
 * Strips internal fields (`emergency_contact`, `review_note`, `revoked_reason`,
 * `reviewed_by`, `revoked_by`) when returning a dossier to the public.
 */
function formatPublicDossier(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    incident_name: row.incident_name,
    disaster_type: row.disaster_type,
    severity_level: row.severity_level,
    affected_region: row.affected_region,
    affected_population: row.affected_population,
    responder_organization: row.responder_organization,
    verification_badge: row.verification_badge,
    evidence_items: Array.isArray(row.evidence_items) ? row.evidence_items : [],
    status: row.status,
    rapid_disbursement_enabled: Boolean(row.rapid_disbursement_enabled),
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Full view for campaign owners, accepted managers, and admins.
 */
function formatManagerDossier(row, now = new Date()) {
  if (!row) return null;
  return {
    ...formatPublicDossier(row),
    created_by: row.created_by,
    emergency_contact: row.emergency_contact,
    reviewed_by: row.reviewed_by,
    review_note: row.review_note,
    revoked_by: row.revoked_by,
    revoked_reason: row.revoked_reason,
    sla: computeSlaMetrics(row, now),
  };
}

async function recordEvent(
  runner,
  { dossierId, campaignId, actorId, fromStatus, toStatus, note = null, metadata = {} }
) {
  await runner.query(
    `INSERT INTO campaign_disaster_relief_events
       (dossier_id, campaign_id, actor_id, from_status, to_status, note, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      dossierId,
      campaignId,
      actorId || null,
      fromStatus || null,
      toStatus,
      note,
      JSON.stringify(metadata || {}),
    ]
  );
}

async function getDisasterReliefByCampaign(campaignId) {
  const { rows } = await db.query('SELECT * FROM campaign_disaster_relief WHERE campaign_id = $1', [
    campaignId,
  ]);
  return rows[0] || null;
}

/**
 * Returns the contextual disaster-relief payload for a campaign.
 * - Managers/admins see the full dossier in any status, plus live SLA metrics.
 * - Public visitors only see the dossier once it is `verified` or `revoked`,
 *   with internal contact and reviewer notes stripped.
 */
async function getDisasterReliefView(campaignId, { isManager = false, now = new Date() } = {}) {
  const row = await getDisasterReliefByCampaign(campaignId);
  if (!row) return { disaster_relief: null };

  if (isManager) {
    return { disaster_relief: formatManagerDossier(row, now) };
  }

  if (row.status === 'verified' || row.status === 'revoked') {
    return { disaster_relief: formatPublicDossier(row) };
  }

  return { disaster_relief: null };
}

/**
 * Creates a disaster-relief dossier in `draft` status for a campaign.
 */
async function createDisasterReliefDossier({ campaignId, actorId, req = null, ...input }) {
  const parsed = validateDossierInput(input);
  if (!parsed.ok) throw domainError(parsed.error, parsed.status);

  const { rows: campaignRows } = await db.query(
    'SELECT id, creator_id, title, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
    [campaignId]
  );
  const campaign = campaignRows[0];
  if (!campaign) throw domainError('Campaign not found', 404);
  if (!ELIGIBLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
    throw domainError(
      `Disaster-relief mode cannot be enabled on a campaign with status "${campaign.status}"`,
      409
    );
  }

  const d = parsed.dossier;
  let created;
  try {
    const { rows } = await db.query(
      `INSERT INTO campaign_disaster_relief
         (campaign_id, created_by, incident_name, disaster_type, severity_level,
          affected_region, affected_population, responder_organization,
          emergency_contact, evidence_items, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'draft')
       RETURNING *`,
      [
        campaignId,
        actorId,
        d.incident_name,
        d.disaster_type,
        d.severity_level,
        d.affected_region,
        d.affected_population,
        d.responder_organization,
        d.emergency_contact,
        JSON.stringify(d.evidence_items),
      ]
    );
    created = rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw domainError('A disaster-relief dossier already exists for this campaign', 409);
    }
    throw err;
  }

  await recordEvent(db, {
    dossierId: created.id,
    campaignId,
    actorId,
    fromStatus: null,
    toStatus: 'draft',
    metadata: {
      disaster_type: created.disaster_type,
      severity_level: created.severity_level,
    },
  });

  await logAuditEvent({
    actorId,
    action: 'disaster_relief.created',
    resourceType: 'campaign',
    resourceId: campaignId,
    after: {
      dossier_id: created.id,
      incident_name: created.incident_name,
      disaster_type: created.disaster_type,
      severity_level: created.severity_level,
      status: created.status,
    },
    req,
  });

  return formatManagerDossier(created);
}

/**
 * Updates the disaster-relief dossier while it is in `draft` or `changes_requested` status.
 */
async function updateDisasterReliefDossier({ campaignId, actorId, req = null, ...input }) {
  const parsed = validateDossierInput(input);
  if (!parsed.ok) throw domainError(parsed.error, parsed.status);

  const existing = await getDisasterReliefByCampaign(campaignId);
  if (!existing) {
    throw domainError('No disaster-relief dossier exists for this campaign', 404);
  }
  if (existing.status !== 'draft' && existing.status !== 'changes_requested') {
    throw domainError(
      `Only draft or changes_requested dossiers can be edited (current status: ${existing.status})`,
      409
    );
  }

  const d = parsed.dossier;
  const { rows } = await db.query(
    `UPDATE campaign_disaster_relief
     SET incident_name          = $1,
         disaster_type          = $2,
         severity_level         = $3,
         affected_region        = $4,
         affected_population    = $5,
         responder_organization = $6,
         emergency_contact      = $7,
         evidence_items         = $8::jsonb,
         updated_at             = NOW()
     WHERE id = $9 AND status = $10
     RETURNING *`,
    [
      d.incident_name,
      d.disaster_type,
      d.severity_level,
      d.affected_region,
      d.affected_population,
      d.responder_organization,
      d.emergency_contact,
      JSON.stringify(d.evidence_items),
      existing.id,
      existing.status,
    ]
  );

  if (!rows.length) {
    throw domainError(
      'The dossier status changed while you were editing; refresh and try again',
      409
    );
  }

  return formatManagerDossier(rows[0]);
}

/**
 * Submits a `draft` or `changes_requested` dossier into the rapid verification queue (`pending_review`).
 */
async function submitForRapidVerification({ campaignId, actorId, req = null }) {
  const existing = await getDisasterReliefByCampaign(campaignId);
  if (!existing) {
    throw domainError('No disaster-relief dossier exists for this campaign', 404);
  }

  if (!TRANSITIONS[existing.status]?.includes('pending_review')) {
    throw domainError(`Cannot submit a dossier from status "${existing.status}"`, 409);
  }

  const evidence = Array.isArray(existing.evidence_items) ? existing.evidence_items : [];
  if (evidence.length === 0) {
    throw domainError(
      'At least one verified HTTPS evidence item is required before submitting for rapid verification',
      422
    );
  }
  if (!existing.emergency_contact || !String(existing.emergency_contact).trim()) {
    throw domainError(
      'An emergency contact is required before submitting for rapid verification',
      422
    );
  }

  const { rows } = await db.query(
    `UPDATE campaign_disaster_relief
     SET status       = 'pending_review',
         submitted_at = NOW(),
         updated_at   = NOW()
     WHERE id = $1 AND status = $2
     RETURNING *`,
    [existing.id, existing.status]
  );

  if (!rows.length) {
    throw domainError('The dossier status changed concurrently; refresh and try again', 409);
  }

  const updated = rows[0];
  await recordEvent(db, {
    dossierId: updated.id,
    campaignId,
    actorId,
    fromStatus: existing.status,
    toStatus: 'pending_review',
    metadata: { evidence_count: evidence.length },
  });

  await logAuditEvent({
    actorId,
    action: 'disaster_relief.submitted',
    resourceType: 'campaign',
    resourceId: campaignId,
    before: { status: existing.status },
    after: { status: updated.status, submitted_at: updated.submitted_at },
    req,
  });

  return formatManagerDossier(updated);
}

/**
 * Admin rapid verification decision: `verified`, `changes_requested`, or `rejected`.
 */
async function reviewDisasterReliefDossier({
  campaignId,
  reviewerId,
  decision,
  note = null,
  verificationBadge = null,
  rapidDisbursementEnabled = true,
  req = null,
}) {
  const normalizedDecision = typeof decision === 'string' ? decision.trim().toLowerCase() : '';
  if (!['verified', 'changes_requested', 'rejected'].includes(normalizedDecision)) {
    throw domainError('decision must be one of: verified, changes_requested, rejected', 422);
  }

  const cleanedNote = cleanText(note) || null;
  if (cleanedNote && cleanedNote.length > MAX_REVIEW_NOTE_LENGTH) {
    throw domainError(`note must be at most ${MAX_REVIEW_NOTE_LENGTH} characters`, 422);
  }
  if (
    (normalizedDecision === 'changes_requested' || normalizedDecision === 'rejected') &&
    !cleanedNote
  ) {
    throw domainError(
      `A reviewer note is required when marking a dossier as ${normalizedDecision}`,
      422
    );
  }

  const cleanedBadge =
    normalizedDecision === 'verified'
      ? cleanText(verificationBadge) || 'Verified Rapid Response'
      : null;
  if (cleanedBadge && cleanedBadge.length > MAX_BADGE_LENGTH) {
    throw domainError(`verification_badge must be at most ${MAX_BADGE_LENGTH} characters`, 422);
  }

  const { rows: campaignRows } = await db.query(
    'SELECT id, creator_id, title FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
    [campaignId]
  );
  const campaign = campaignRows[0];
  if (!campaign) throw domainError('Campaign not found', 404);

  const existing = await getDisasterReliefByCampaign(campaignId);
  if (!existing) {
    throw domainError('No disaster-relief dossier exists for this campaign', 404);
  }
  if (!TRANSITIONS[existing.status]?.includes(normalizedDecision)) {
    throw domainError(
      `Cannot review a dossier in "${existing.status}" status (must be pending_review)`,
      409
    );
  }

  const enableRapid = normalizedDecision === 'verified' ? Boolean(rapidDisbursementEnabled) : false;

  const { rows } = await db.query(
    `UPDATE campaign_disaster_relief
     SET status                     = $1,
         reviewed_by                = $2,
         reviewed_at                = NOW(),
         review_note                = $3,
         verification_badge         = $4,
         rapid_disbursement_enabled = $5,
         updated_at                 = NOW()
     WHERE id = $6 AND status = 'pending_review'
     RETURNING *`,
    [normalizedDecision, reviewerId, cleanedNote, cleanedBadge, enableRapid, existing.id]
  );

  if (!rows.length) {
    throw domainError('The dossier status changed concurrently; refresh and try again', 409);
  }

  const updated = rows[0];
  await recordEvent(db, {
    dossierId: updated.id,
    campaignId,
    actorId: reviewerId,
    fromStatus: existing.status,
    toStatus: normalizedDecision,
    note: cleanedNote,
    metadata: {
      verification_badge: cleanedBadge,
      rapid_disbursement_enabled: enableRapid,
    },
  });

  await logAuditEvent({
    actorId: reviewerId,
    action: `disaster_relief.${normalizedDecision}`,
    resourceType: 'campaign',
    resourceId: campaignId,
    before: { status: existing.status },
    after: {
      status: updated.status,
      verification_badge: updated.verification_badge,
      rapid_disbursement_enabled: updated.rapid_disbursement_enabled,
    },
    metadata: { note: cleanedNote },
    req,
  });

  if (campaign.creator_id) {
    try {
      const messages = {
        verified: `Your campaign "${campaign.title}" has been verified for disaster-relief mode (${cleanedBadge}).`,
        changes_requested: `Rapid verification reviewers requested changes on "${campaign.title}": ${cleanedNote}`,
        rejected: `Rapid verification for "${campaign.title}" was declined: ${cleanedNote}`,
      };
      await createNotification(campaign.creator_id, messages[normalizedDecision]);
    } catch (err) {
      logger.error('Disaster-relief review notification failed', {
        campaign_id: campaignId,
        error: err.message,
      });
    }
  }

  return formatManagerDossier(updated);
}

/**
 * Revokes a previously `verified` disaster-relief dossier (`verified` -> `revoked`).
 */
async function revokeDisasterReliefVerification({ campaignId, actorId, reason, req = null }) {
  const cleanedReason = cleanText(reason);
  if (!cleanedReason) {
    throw domainError('A reason is required to revoke disaster-relief verification', 422);
  }
  if (cleanedReason.length > MAX_REVIEW_NOTE_LENGTH) {
    throw domainError(`reason must be at most ${MAX_REVIEW_NOTE_LENGTH} characters`, 422);
  }

  const { rows: campaignRows } = await db.query(
    'SELECT id, creator_id, title FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
    [campaignId]
  );
  const campaign = campaignRows[0];
  if (!campaign) throw domainError('Campaign not found', 404);

  const existing = await getDisasterReliefByCampaign(campaignId);
  if (!existing) {
    throw domainError('No disaster-relief dossier exists for this campaign', 404);
  }
  if (!TRANSITIONS[existing.status]?.includes('revoked')) {
    throw domainError(
      `Only a verified dossier can be revoked (current status: ${existing.status})`,
      409
    );
  }

  const { rows } = await db.query(
    `UPDATE campaign_disaster_relief
     SET status                     = 'revoked',
         rapid_disbursement_enabled = FALSE,
         revoked_by                 = $1,
         revoked_at                 = NOW(),
         revoked_reason             = $2,
         updated_at                 = NOW()
     WHERE id = $3 AND status = 'verified'
     RETURNING *`,
    [actorId, cleanedReason, existing.id]
  );

  if (!rows.length) {
    throw domainError('The dossier status changed concurrently; refresh and try again', 409);
  }

  const updated = rows[0];
  await recordEvent(db, {
    dossierId: updated.id,
    campaignId,
    actorId,
    fromStatus: existing.status,
    toStatus: 'revoked',
    note: cleanedReason,
  });

  await logAuditEvent({
    actorId,
    action: 'disaster_relief.revoked',
    resourceType: 'campaign',
    resourceId: campaignId,
    before: {
      status: existing.status,
      rapid_disbursement_enabled: existing.rapid_disbursement_enabled,
    },
    after: { status: updated.status, rapid_disbursement_enabled: false },
    metadata: { reason: cleanedReason },
    req,
  });

  if (campaign.creator_id) {
    try {
      await createNotification(
        campaign.creator_id,
        `Disaster-relief verification for "${campaign.title}" was revoked: ${cleanedReason}`
      );
    } catch (err) {
      logger.error('Disaster-relief revocation notification failed', {
        campaign_id: campaignId,
        error: err.message,
      });
    }
  }

  return formatManagerDossier(updated);
}

/**
 * Lists the lifecycle audit trail for a campaign's disaster-relief dossier.
 */
async function listEvents(campaignId) {
  const { rows } = await db.query(
    `SELECT id, dossier_id, campaign_id, actor_id, from_status, to_status, note, metadata, created_at
     FROM campaign_disaster_relief_events
     WHERE campaign_id = $1
     ORDER BY created_at ASC, id ASC`,
    [campaignId]
  );
  return rows;
}

/**
 * Admin rapid verification queue ordered by severity and submission timestamp (oldest first).
 */
async function listRapidVerificationQueue({
  status = 'pending_review',
  limit = 50,
  now = new Date(),
} = {}) {
  const normalizedStatus =
    typeof status === 'string' ? status.trim().toLowerCase() : 'pending_review';
  if (!VERIFICATION_STATUSES.includes(normalizedStatus)) {
    throw domainError(`status must be one of: ${VERIFICATION_STATUSES.join(', ')}`, 422);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const { rows } = await db.query(
    `SELECT dr.*,
            c.title AS campaign_title,
            c.status AS campaign_status,
            c.creator_id AS creator_id
     FROM campaign_disaster_relief dr
     JOIN campaigns c ON c.id = dr.campaign_id AND c.deleted_at IS NULL
     WHERE dr.status = $1
     ORDER BY
       CASE dr.severity_level
         WHEN 'catastrophic' THEN 1
         WHEN 'critical' THEN 2
         WHEN 'urgent' THEN 3
         ELSE 4
       END ASC,
       dr.submitted_at ASC NULLS LAST,
       dr.created_at ASC
     LIMIT $2`,
    [normalizedStatus, safeLimit]
  );

  return rows.map(row => ({
    ...formatManagerDossier(row, now),
    campaign_title: row.campaign_title,
    campaign_status: row.campaign_status,
    creator_id: row.creator_id,
  }));
}

module.exports = {
  DISASTER_TYPES,
  SEVERITY_LEVELS,
  EVIDENCE_TYPES,
  VERIFICATION_STATUSES,
  ELIGIBLE_CAMPAIGN_STATUSES,
  RAPID_VERIFICATION_SLA_HOURS,
  MAX_INCIDENT_NAME_LENGTH,
  MAX_REGION_LENGTH,
  MAX_RESPONDER_ORG_LENGTH,
  MAX_EMERGENCY_CONTACT_LENGTH,
  MAX_BADGE_LENGTH,
  MAX_REVIEW_NOTE_LENGTH,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_TITLE_LENGTH,
  MAX_EVIDENCE_ISSUER_LENGTH,
  MAX_EVIDENCE_URL_LENGTH,
  MAX_AFFECTED_POPULATION,
  TRANSITIONS,
  validateEvidenceItems,
  validateDossierInput,
  computeSlaMetrics,
  formatPublicDossier,
  formatManagerDossier,
  getDisasterReliefByCampaign,
  getDisasterReliefView,
  createDisasterReliefDossier,
  updateDisasterReliefDossier,
  submitForRapidVerification,
  reviewDisasterReliefDossier,
  revokeDisasterReliefVerification,
  listEvents,
  listRapidVerificationQueue,
};
