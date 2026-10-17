const db = require('../config/database');
const logger = require('../config/logger');
const { createNotificationsBulk } = require('./notifications');
const { filterEnabledUsers } = require('./communicationPreferenceService');
const { logAuditEvent } = require('./auditService');

// Beneficiary outcome surveys after campaign completion (#960).
//
// A creator closes a campaign, then asks the people who actually backed it
// what happened. "Beneficiary" here means a contributor to that specific
// campaign: the survey is research *from the people who funded the work*, so
// eligibility is derived from the contribution ledger rather than from
// follow rows or account role.
//
// Lifecycle: draft -> open -> closed. Exactly one survey per campaign, so a
// duplicate create is a deterministic 409 and the state machine is a series
// of compare-and-set UPDATEs that concurrent callers cannot interleave.

const SURVEY_ELIGIBLE_CAMPAIGN_STATUSES = ['completed', 'funded', 'in_progress', 'closed'];
const OPEN_STATUS = 'open';
const CLOSED_STATUS = 'closed';
const DRAFT_STATUS = 'draft';

const QUESTION_TYPES = ['rating', 'single_choice', 'text'];
const RATING_MIN = 1;
const RATING_MAX = 5;

const MAX_QUESTIONS = 10;
const MAX_TITLE_LENGTH = 200;
const MAX_INTRO_LENGTH = 2000;
const MAX_PROMPT_LENGTH = 500;
const MAX_OPTIONS = 10;
const MAX_OPTION_LENGTH = 200;
const MAX_TEXT_ANSWER_LENGTH = 2000;

// Statuses a survey can move to from its current status. Used to turn an
// impossible transition into a 409 instead of a silent no-op.
const TRANSITIONS = {
  [DRAFT_STATUS]: [OPEN_STATUS, CLOSED_STATUS],
  [OPEN_STATUS]: [CLOSED_STATUS],
  [CLOSED_STATUS]: [],
};

function domainError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function slugify(value, index) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `q${index + 1}`;
}

/**
 * Validates and normalizes a survey payload.
 *
 * @param {object} input `{ title, intro, questions }`
 * @returns {{ok: true, survey: object} | {ok: false, status: number, error: string, field?: string}}
 */
function validateSurveyInput(input = {}) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) return { ok: false, status: 422, field: 'title', error: 'title is required' };
  if (title.length > MAX_TITLE_LENGTH) {
    return {
      ok: false,
      status: 422,
      field: 'title',
      error: `title must be at most ${MAX_TITLE_LENGTH} characters`,
    };
  }

  const intro = typeof input.intro === 'string' && input.intro.trim() ? input.intro.trim() : null;
  if (intro && intro.length > MAX_INTRO_LENGTH) {
    return {
      ok: false,
      status: 422,
      field: 'intro',
      error: `intro must be at most ${MAX_INTRO_LENGTH} characters`,
    };
  }

  const questions = validateQuestions(input.questions);
  if (!questions.ok) return questions;

  return { ok: true, survey: { title, intro, questions: questions.questions } };
}

/**
 * Validates the question set. Ids are derived from the prompt so re-opening
 * and re-saving a survey does not orphan already-collected answers.
 *
 * @param {unknown} raw
 * @returns {{ok: true, questions: object[]} | {ok: false, status: number, error: string, field?: string}}
 */
function validateQuestions(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, status: 422, field: 'questions', error: 'questions must be an array' };
  }
  if (raw.length > MAX_QUESTIONS) {
    return {
      ok: false,
      status: 422,
      field: 'questions',
      error: `a survey may contain at most ${MAX_QUESTIONS} questions`,
    };
  }

  const usedIds = new Set();
  const questions = [];
  for (const [index, item] of raw.entries()) {
    const prompt = typeof item?.prompt === 'string' ? item.prompt.trim() : '';
    if (!prompt) {
      return {
        ok: false,
        status: 422,
        field: `questions[${index}].prompt`,
        error: 'every question needs a prompt',
      };
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return {
        ok: false,
        status: 422,
        field: `questions[${index}].prompt`,
        error: `question prompts are limited to ${MAX_PROMPT_LENGTH} characters`,
      };
    }

    const type = QUESTION_TYPES.includes(item?.type) ? item.type : 'rating';
    const required = item?.required === false ? false : true;

    // Duplicate prompts would collapse into the same generated id, which
    // would make answers ambiguous — disambiguate instead of rejecting.
    let id =
      item?.id && typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : slugify(prompt, index);
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}_${suffix}`)) suffix += 1;
      id = `${id}_${suffix}`;
    }
    usedIds.add(id);

    let options = null;
    if (type === 'single_choice') {
      const rawOptions = Array.isArray(item?.options) ? item.options : [];
      const cleaned = rawOptions
        .filter(option => typeof option === 'string' && option.trim())
        .map(option => option.trim().slice(0, MAX_OPTION_LENGTH));
      if (cleaned.length < 2) {
        return {
          ok: false,
          status: 422,
          field: `questions[${index}].options`,
          error: 'single_choice questions need at least two options',
        };
      }
      if (cleaned.length > MAX_OPTIONS) {
        return {
          ok: false,
          status: 422,
          field: `questions[${index}].options`,
          error: `single_choice questions allow at most ${MAX_OPTIONS} options`,
        };
      }
      const deduped = [...new Set(cleaned)];
      if (deduped.length < 2) {
        return {
          ok: false,
          status: 422,
          field: `questions[${index}].options`,
          error: 'single_choice questions need at least two distinct options',
        };
      }
      options = deduped;
    }

    questions.push({ id, prompt, type, required, options });
  }

  return { ok: true, questions };
}

/**
 * Validates a submission against the stored question set. Unknown question
 * ids are rejected (a stale client), required questions must be answered, and
 * each answer is range/length checked against its declared type.
 *
 * @param {object[]} questions stored questions
 * @param {object} answers map of question id -> answer
 * @returns {{ok: true, answers: object} | {ok: false, status: number, error: string, field?: string}}
 */
function validateAnswers(questions, answers) {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    return { ok: false, status: 422, field: 'answers', error: 'answers must be an object' };
  }

  const byId = new Map((questions || []).map(question => [question.id, question]));
  const unknown = Object.keys(answers).filter(id => !byId.has(id));
  if (unknown.length) {
    return {
      ok: false,
      status: 422,
      field: 'answers',
      error: `unknown question ids: ${unknown.join(', ')}`,
    };
  }

  const normalized = {};
  for (const question of questions || []) {
    const raw = answers[question.id];
    if (raw === undefined || raw === null || raw === '') {
      if (question.required) {
        return {
          ok: false,
          status: 422,
          field: `answers.${question.id}`,
          error: `question "${question.prompt}" is required`,
        };
      }
      continue;
    }

    if (question.type === 'rating') {
      // `Number(true) === 1` and `Number(null) === 0`, so the type has to be
      // checked explicitly rather than relying on the range check alone.
      const numericLike =
        typeof raw === 'number' || (typeof raw === 'string' && /^-?\d+$/.test(raw.trim()));
      const value = numericLike ? Number(raw) : NaN;
      if (!Number.isInteger(value) || value < RATING_MIN || value > RATING_MAX) {
        return {
          ok: false,
          status: 422,
          field: `answers.${question.id}`,
          error: `rating answers must be a whole number between ${RATING_MIN} and ${RATING_MAX}`,
        };
      }
      normalized[question.id] = value;
    } else if (question.type === 'single_choice') {
      if (typeof raw !== 'string' || !(question.options || []).includes(raw)) {
        return {
          ok: false,
          status: 422,
          field: `answers.${question.id}`,
          error: `answer must be one of: ${(question.options || []).join(', ')}`,
        };
      }
      normalized[question.id] = raw;
    } else {
      if (typeof raw !== 'string') {
        return {
          ok: false,
          status: 422,
          field: `answers.${question.id}`,
          error: 'text answers must be strings',
        };
      }
      const text = raw.trim();
      if (text.length > MAX_TEXT_ANSWER_LENGTH) {
        return {
          ok: false,
          status: 422,
          field: `answers.${question.id}`,
          error: `text answers are limited to ${MAX_TEXT_ANSWER_LENGTH} characters`,
        };
      }
      if (!text && question.required) {
        return {
          ok: false,
          status: 422,
          field: `answers.${question.id}`,
          error: `question "${question.prompt}" is required`,
        };
      }
      if (text) normalized[question.id] = text;
    }
  }

  return { ok: true, answers: normalized };
}

/** Whether a campaign has reached a state where outcome research makes sense. */
function isCampaignEligible(status) {
  return SURVEY_ELIGIBLE_CAMPAIGN_STATUSES.includes(status);
}

function mapSurvey(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    created_by: row.created_by,
    title: row.title,
    intro: row.intro,
    questions: row.questions || [],
    status: row.status,
    opens_at: row.opens_at,
    closes_at: row.closes_at,
    published_at: row.published_at,
    closed_at: row.closed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getSurveyByCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT id, campaign_id, created_by, title, intro, questions, status, opens_at, closes_at,
            published_at, closed_at, created_at, updated_at
     FROM campaign_outcome_surveys
     WHERE campaign_id = $1`,
    [campaignId]
  );
  return mapSurvey(rows[0]);
}

async function recordEvent(
  client,
  { surveyId, campaignId, actorId, fromStatus, toStatus, metadata }
) {
  await client.query(
    `INSERT INTO campaign_outcome_survey_events
       (survey_id, campaign_id, actor_id, from_status, to_status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      surveyId,
      campaignId,
      actorId || null,
      fromStatus || null,
      toStatus,
      JSON.stringify(metadata || {}),
    ]
  );
}

/**
 * Loads the campaign and asserts the survey window. Backward compatible with
 * campaigns created before this feature: the statuses list is explicit, so an
 * unexpected status fails closed with a 409 rather than silently allowing.
 */
async function loadEligibleCampaign(campaignId) {
  const { rows } = await db.query(
    'SELECT id, creator_id, title, status FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
    [campaignId]
  );
  if (!rows.length) throw domainError('Campaign not found', 404);
  const campaign = rows[0];
  if (!isCampaignEligible(campaign.status)) {
    throw domainError(
      `Outcome surveys can only be created once the campaign has finished funding (current status: "${campaign.status}")`,
      409
    );
  }
  return campaign;
}

/**
 * Creates the single outcome survey for a campaign.
 *
 * @param {object} params
 * @returns {Promise<object>} the created survey
 * @throws {Error} 404 unknown campaign, 409 campaign not finished, 409 duplicate
 */
async function createSurvey({ campaignId, creatorId, ...input }) {
  const campaign = await loadEligibleCampaign(campaignId);
  const parsed = validateSurveyInput(input);
  if (!parsed.ok) throw domainError(parsed.error, parsed.status);

  const { rows } = await db.query(
    `INSERT INTO campaign_outcome_surveys (campaign_id, created_by, title, intro, questions)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, campaign_id, created_by, title, intro, questions, status, opens_at, closes_at,
               published_at, closed_at, created_at, updated_at`,
    [
      campaignId,
      creatorId,
      parsed.survey.title,
      parsed.survey.intro,
      JSON.stringify(parsed.survey.questions),
    ]
  );
  const survey = mapSurvey(rows[0]);

  await recordEventSafely({
    surveyId: survey.id,
    campaignId,
    actorId: creatorId,
    fromStatus: null,
    toStatus: DRAFT_STATUS,
    metadata: { questions: survey.questions.length, campaign: campaign.status },
  });
  await auditSafely({
    actorId: creatorId,
    action: 'outcome_survey_created',
    resourceId: survey.id,
    metadata: { campaignId, questions: survey.questions.length },
  });
  return survey;
}

/**
 * Updates a survey that has not been published yet. Rejected with 409 once
 * the survey is open or closed so in-flight responses are never re-scoped.
 */
async function updateSurvey({ campaignId, ...input }) {
  const existing = await getSurveyByCampaign(campaignId);
  if (!existing) throw domainError('Outcome survey not found', 404);
  if (existing.status !== DRAFT_STATUS) {
    throw domainError(`The outcome survey cannot be edited while it is "${existing.status}"`, 409);
  }
  const parsed = validateSurveyInput(input);
  if (!parsed.ok) throw domainError(parsed.error, parsed.status);

  const { rows } = await db.query(
    `UPDATE campaign_outcome_surveys
     SET title = $2, intro = $3, questions = $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING id, campaign_id, created_by, title, intro, questions, status, opens_at, closes_at,
               published_at, closed_at, created_at, updated_at`,
    [existing.id, parsed.survey.title, parsed.survey.intro, JSON.stringify(parsed.survey.questions)]
  );
  if (!rows.length) {
    throw domainError('The outcome survey is no longer a draft', 409);
  }
  await recordEventSafely({
    surveyId: existing.id,
    campaignId,
    actorId: input.actorId,
    fromStatus: DRAFT_STATUS,
    toStatus: DRAFT_STATUS,
    metadata: { updated: true },
  });
  return mapSurvey(rows[0]);
}

/**
 * Publishes the survey and invites every eligible backer who has not muted the
 * `surveys` communication channel for this campaign (#961).
 *
 * @returns {Promise<{survey: object, invited: number}>}
 */
async function openSurvey({ campaignId, actorId, closesAt = null }) {
  const existing = await getSurveyByCampaign(campaignId);
  if (!existing) throw domainError('Outcome survey not found', 404);
  if (!TRANSITIONS[existing.status]?.includes(OPEN_STATUS)) {
    throw domainError(`The outcome survey cannot be opened while it is "${existing.status}"`, 409);
  }
  if (!existing.questions.length) {
    throw domainError('Add at least one question before opening the survey', 409);
  }
  if (closesAt && new Date(closesAt) <= new Date()) {
    throw domainError('closes_at must be in the future', 422);
  }

  // Compare-and-set: a concurrent open loses the race and gets a 409 rather
  // than double-notifying every backer.
  const { rows } = await db.query(
    `UPDATE campaign_outcome_surveys
     SET status = 'open', opens_at = NOW(), published_at = NOW(), closes_at = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING id, campaign_id, created_by, title, intro, questions, status, opens_at, closes_at,
               published_at, closed_at, created_at, updated_at`,
    [existing.id, closesAt]
  );
  if (!rows.length) {
    throw domainError('The outcome survey is no longer a draft', 409);
  }
  const survey = mapSurvey(rows[0]);

  const invited = await notifyBackers(survey, actorId);
  await recordEventSafely({
    surveyId: survey.id,
    campaignId,
    actorId,
    fromStatus: DRAFT_STATUS,
    toStatus: OPEN_STATUS,
    metadata: { invited, closes_at: closesAt },
  });
  await auditSafely({
    actorId,
    action: 'outcome_survey_opened',
    resourceId: survey.id,
    metadata: { campaignId, invited },
  });
  return { survey, invited };
}

/**
 * Stops accepting responses. Idempotent for an already-closed survey so a
 * retried close does not error.
 */
async function closeSurvey({ campaignId, actorId }) {
  const existing = await getSurveyByCampaign(campaignId);
  if (!existing) throw domainError('Outcome survey not found', 404);
  if (existing.status === CLOSED_STATUS) return { survey: existing, already_closed: true };

  const { rows } = await db.query(
    `UPDATE campaign_outcome_surveys
     SET status = 'closed', closed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'open'
     RETURNING id, campaign_id, created_by, title, intro, questions, status, opens_at, closes_at,
               published_at, closed_at, created_at, updated_at`,
    [existing.id]
  );
  if (!rows.length) throw domainError('The outcome survey is no longer open', 409);
  const survey = mapSurvey(rows[0]);

  await recordEventSafely({
    surveyId: survey.id,
    campaignId,
    actorId,
    fromStatus: OPEN_STATUS,
    toStatus: CLOSED_STATUS,
    metadata: {},
  });
  await auditSafely({
    actorId,
    action: 'outcome_survey_closed',
    resourceId: survey.id,
    metadata: { campaignId },
  });
  return { survey, already_closed: false };
}

/**
 * Whether a user actually backed the campaign. This is the tenancy boundary
 * for the whole feature: a non-contributor cannot submit or read a response,
 * even with a valid session.
 *
 * @param {string} campaignId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isBeneficiary(campaignId, userId) {
  const { rows } = await db.query(
    `SELECT 1
     FROM contributions c
     JOIN users u ON u.wallet_public_key = c.sender_public_key
     WHERE c.campaign_id = $1 AND u.id = $2
     LIMIT 1`,
    [campaignId, userId]
  );
  return rows.length > 0;
}

async function getResponse(surveyId, userId) {
  const { rows } = await db.query(
    `SELECT id, survey_id, campaign_id, user_id, answers, submitted_at, updated_at
     FROM campaign_outcome_survey_responses
     WHERE survey_id = $1 AND user_id = $2`,
    [surveyId, userId]
  );
  if (!rows.length) return null;
  return rows[0];
}

/**
 * Public read model. Always returns the survey and the aggregate response
 * count; individual answers are only ever included for the caller's own
 * response.
 */
async function getPublicSurvey(campaignId, viewerId = null) {
  const survey = await getSurveyByCampaign(campaignId);
  if (!survey) return { survey: null, response_count: 0, my_response: null };

  const { rows: countRows } = await db.query(
    'SELECT COUNT(*)::int AS total FROM campaign_outcome_survey_responses WHERE survey_id = $1',
    [survey.id]
  );

  let myResponse = null;
  if (viewerId) {
    myResponse = await getResponse(survey.id, viewerId);
  }
  return {
    survey,
    response_count: countRows[0]?.total || 0,
    my_response: myResponse,
  };
}

/**
 * Records a backer's submission.
 *
 * Exactly one response per (survey, user): the UNIQUE constraint is the
 * arbiter, so two concurrent submissions produce one 201 and one 409 rather
 * than two rows.
 *
 * @param {object} params
 * @returns {Promise<object>} the stored response row
 */
async function submitResponse({ campaignId, userId, answers }) {
  const survey = await getSurveyByCampaign(campaignId);
  if (!survey) throw domainError('Outcome survey not found', 404);
  if (survey.status !== OPEN_STATUS) {
    throw domainError(
      `The outcome survey is not accepting responses (status: "${survey.status}")`,
      409
    );
  }
  if (survey.closes_at && new Date(survey.closes_at) <= new Date()) {
    throw domainError('The outcome survey has closed', 409);
  }
  if (!(await isBeneficiary(campaignId, userId))) {
    throw domainError('Only contributors to this campaign can respond to its outcome survey', 403);
  }

  const parsed = validateAnswers(survey.questions, answers);
  if (!parsed.ok) throw domainError(parsed.error, parsed.status);

  const existing = await getResponse(survey.id, userId);
  if (existing) {
    throw domainError('You have already responded to this outcome survey', 409);
  }

  const { rows } = await db.query(
    `INSERT INTO campaign_outcome_survey_responses (survey_id, campaign_id, user_id, answers)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (survey_id, user_id) DO NOTHING
     RETURNING id, survey_id, campaign_id, user_id, answers, submitted_at, updated_at`,
    [survey.id, campaignId, userId, JSON.stringify(parsed.answers)]
  );
  if (!rows.length) {
    throw domainError('You have already responded to this outcome survey', 409);
  }
  return rows[0];
}

/**
 * Aggregated results for the creator/manager. Never returns per-respondent
 * rows, so a creator cannot deanonymise their backers from this endpoint.
 *
 * @param {string} campaignId
 * @returns {Promise<{survey: object, response_count: number, results: object[]}>}
 */
async function getResults(campaignId) {
  const survey = await getSurveyByCampaign(campaignId);
  if (!survey) throw domainError('Outcome survey not found', 404);

  const { rows: responses } = await db.query(
    `SELECT answers
     FROM campaign_outcome_survey_responses
     WHERE survey_id = $1
     ORDER BY submitted_at ASC`,
    [survey.id]
  );

  const byQuestion = new Map();
  for (const question of survey.questions) {
    byQuestion.set(question.id, {
      question_id: question.id,
      prompt: question.prompt,
      type: question.type,
      options: question.options,
      answered: 0,
      skipped: 0,
      rating_total: 0,
      rating_count: 0,
      average_rating: null,
      distribution: {},
      sample_responses: [],
    });
  }

  for (const response of responses) {
    const answers = response.answers || {};
    for (const question of survey.questions) {
      const bucket = byQuestion.get(question.id);
      const value = answers[question.id];
      if (value === undefined || value === null || value === '') {
        bucket.skipped += 1;
        continue;
      }
      bucket.answered += 1;
      if (question.type === 'rating') {
        const rating = Number(value);
        bucket.rating_total += rating;
        bucket.rating_count += 1;
        bucket.distribution[rating] = (bucket.distribution[rating] || 0) + 1;
      } else if (question.type === 'single_choice') {
        bucket.distribution[value] = (bucket.distribution[value] || 0) + 1;
      } else {
        // Free text is aggregated by frequency; cap the retained samples so a
        // survey with long answers cannot grow the payload without bound.
        bucket.distribution[value] = (bucket.distribution[value] || 0) + 1;
        if (bucket.sample_responses.length < 20) bucket.sample_responses.push(value);
      }
    }
  }

  const results = [...byQuestion.values()].map(bucket => ({
    ...bucket,
    average_rating:
      bucket.rating_count > 0
        ? Math.round((bucket.rating_total / bucket.rating_count) * 100) / 100
        : null,
  }));

  return { survey, response_count: responses.length, results };
}

async function listEvents(campaignId) {
  const survey = await getSurveyByCampaign(campaignId);
  if (!survey) return [];
  const { rows } = await db.query(
    `SELECT id, actor_id, from_status, to_status, metadata, created_at
     FROM campaign_outcome_survey_events
     WHERE survey_id = $1
     ORDER BY created_at ASC`,
    [survey.id]
  );
  return rows;
}

/**
 * Notifies every backer that the survey is open, minus anyone who muted the
 * `surveys` channel for this campaign (#961). Never throws — a failed
 * notification must not roll back a published survey.
 *
 * @returns {Promise<number>} number of backers notified
 */
async function notifyBackers(survey, actorId) {
  try {
    const { rows: backers } = await db.query(
      `SELECT DISTINCT ON (u.id) u.id
       FROM contributions c
       JOIN users u ON u.wallet_public_key = c.sender_public_key
       WHERE c.campaign_id = $1
       ORDER BY u.id, c.created_at ASC`,
      [survey.campaign_id]
    );
    const exclude = actorId ? [actorId] : [];
    const recipients = await filterEnabledUsers(
      survey.campaign_id,
      'surveys',
      backers.map(backer => backer.id).filter(id => !exclude.includes(id))
    );
    if (!recipients.length) return 0;

    await createNotificationsBulk(recipients, {
      type: 'outcome_survey_open',
      title: survey.title,
      body: 'This campaign is asking its backers how things went. Your answers help.',
      link: `/campaigns/${survey.campaign_id}#outcome-survey`,
    });
    return recipients.length;
  } catch (err) {
    logger.error('Failed to notify backers about an outcome survey', {
      campaignId: survey.campaign_id,
      surveyId: survey.id,
      error: err.message,
    });
    return 0;
  }
}

// ── best-effort side effects ───────────────────────────────────────────────

async function recordEventSafely(event) {
  try {
    const client = await db.connect();
    try {
      await recordEvent(client, event);
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('outcome-survey: failed to record event', {
      surveyId: event.surveyId,
      error: err.message,
    });
  }
}

async function auditSafely({ actorId, action, resourceId, metadata }) {
  try {
    await logAuditEvent({
      actorId,
      action,
      resourceType: 'campaign_outcome_survey',
      resourceId,
      metadata,
    });
  } catch (err) {
    logger.error('outcome-survey: audit log failed', { action, resourceId, error: err.message });
  }
}

module.exports = {
  SURVEY_ELIGIBLE_CAMPAIGN_STATUSES,
  QUESTION_TYPES,
  MAX_QUESTIONS,
  MAX_TITLE_LENGTH,
  MAX_INTRO_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_OPTIONS,
  MAX_OPTION_LENGTH,
  MAX_TEXT_ANSWER_LENGTH,
  RATING_MIN,
  RATING_MAX,
  TRANSITIONS,
  validateSurveyInput,
  validateQuestions,
  validateAnswers,
  isCampaignEligible,
  getSurveyByCampaign,
  createSurvey,
  updateSurvey,
  openSurvey,
  closeSurvey,
  submitResponse,
  getPublicSurvey,
  getResults,
  getResponse,
  listEvents,
  isBeneficiary,
  notifyBackers,
};
