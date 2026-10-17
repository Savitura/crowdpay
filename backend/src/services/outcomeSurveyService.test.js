const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SURVEY_ID = '33333333-3333-4333-8333-333333333333';

const RATING_Q = {
  id: 'delivery',
  prompt: 'Did the work arrive as promised?',
  type: 'rating',
  required: true,
};
const CHOICE_Q = {
  id: 'reuse',
  prompt: 'Would you back this again?',
  type: 'single_choice',
  required: true,
  options: ['Yes', 'No'],
};
const TEXT_Q = { id: 'notes', prompt: 'Anything else?', type: 'text', required: false };

const QUESTIONS = [RATING_Q, CHOICE_Q, TEXT_Q];

/**
 * Scripted db: `handlers` is an ordered `[sqlFragment, result | fn]` list. The
 * `connect()` client shares the same handler list so transactional statements
 * resolve deterministically.
 */
function buildService(handlers = [], { notificationsThrow = false } = {}) {
  const calls = [];
  const queue = [...handlers];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      const match = queue.find(([fragment]) => String(sql).includes(fragment));
      if (!match) return { rows: [], rowCount: 0 };
      const result = match[1];
      return typeof result === 'function' ? result(sql, params) : result;
    },
    release() {},
  };
  const db = {
    query: (sql, params) => client.query(sql, params),
    connect: async () => client,
  };
  const notified = [];
  const audits = [];
  const service = proxyquire('./outcomeSurveyService', {
    '../config/database': db,
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    './notifications': {
      createNotificationsBulk: async (userIds, message) => {
        if (notificationsThrow) throw new Error('in-app fan-out down');
        notified.push({ userIds, message });
      },
    },
    './communicationPreferenceService': {
      filterEnabledUsers: async (_campaignId, channel, userIds) => userIds,
      __channel: channel => channel,
    },
    './auditService': { logAuditEvent: async event => audits.push(event) },
  });
  return { service, calls, notified, audits };
}

function surveyRow(overrides = {}) {
  return {
    id: SURVEY_ID,
    campaign_id: CAMPAIGN_ID,
    created_by: USER_ID,
    title: 'How did it go?',
    intro: 'Two minutes, tops.',
    questions: QUESTIONS,
    status: 'open',
    opens_at: '2026-10-01T00:00:00.000Z',
    closes_at: null,
    published_at: '2026-10-01T00:00:00.000Z',
    closed_at: null,
    created_at: '2026-09-30T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── validation ─────────────────────────────────────────────────────────────

test('validateSurveyInput normalises a valid draft', () => {
  const { service } = buildService();
  const parsed = service.validateSurveyInput({
    title: '  How did it go?  ',
    intro: '  Two minutes.  ',
    questions: [{ prompt: 'Did the work arrive?', type: 'rating' }],
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.survey.title, 'How did it go?');
  assert.equal(parsed.survey.intro, 'Two minutes.');
  assert.equal(parsed.survey.questions[0].id, 'did_the_work_arrive');
  assert.equal(parsed.survey.questions[0].required, true);
});

test('validateSurveyInput rejects a missing or oversized title', () => {
  const { service } = buildService();
  assert.equal(service.validateSurveyInput({}).ok, false);
  assert.equal(service.validateSurveyInput({}).status, 422);
  assert.equal(service.validateSurveyInput({ title: '   ' }).status, 422);
  assert.equal(
    service.validateSurveyInput({ title: 'x'.repeat(service.MAX_TITLE_LENGTH + 1) }).status,
    422
  );
});

test('validateSurveyInput rejects an oversized intro and clears a blank one', () => {
  const { service } = buildService();
  assert.equal(
    service.validateSurveyInput({ title: 'ok', intro: '   ', questions: [{ prompt: 'q' }] }).survey
      .intro,
    null
  );
  assert.equal(
    service.validateSurveyInput({
      title: 'ok',
      intro: 'x'.repeat(service.MAX_INTRO_LENGTH + 1),
      questions: [{ prompt: 'q' }],
    }).status,
    422
  );
});

test('validateQuestions enforces the question cap', () => {
  const { service } = buildService();
  const many = Array.from({ length: service.MAX_QUESTIONS + 1 }, (_, i) => ({
    prompt: `Question ${i}`,
  }));
  const parsed = service.validateQuestions(many);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /at most 10 questions/);
});

test('validateQuestions rejects a non-array and an empty prompt', () => {
  const { service } = buildService();
  assert.equal(service.validateQuestions('nope').status, 422);
  assert.equal(service.validateQuestions([{ prompt: '  ' }]).status, 422);
  assert.equal(service.validateQuestions([{ prompt: 'x'.repeat(501) }]).status, 422);
});

test('validateQuestions defaults an unknown type to rating', () => {
  const { service } = buildService();
  const parsed = service.validateQuestions([{ prompt: 'Rate us', type: 'mystery' }]);
  assert.equal(parsed.questions[0].type, 'rating');
});

test('validateQuestions requires two distinct options for a single choice', () => {
  const { service } = buildService();
  assert.equal(service.validateQuestions([{ prompt: 'q', type: 'single_choice' }]).status, 422);
  assert.equal(
    service.validateQuestions([{ prompt: 'q', type: 'single_choice', options: ['same', 'same'] }])
      .status,
    422
  );

  const ok = service.validateQuestions([
    { prompt: 'q', type: 'single_choice', options: [' a ', 'b', 'a'] },
  ]);
  assert.deepEqual(ok.questions[0].options, ['a', 'b']);
});

test('validateQuestions caps and truncates option text', () => {
  const { service } = buildService();
  const tooMany = service.validateQuestions([
    {
      prompt: 'q',
      type: 'single_choice',
      options: Array.from({ length: service.MAX_OPTIONS + 1 }, (_, i) => `opt${i}`),
    },
  ]);
  assert.equal(tooMany.status, 422);

  const long = service.validateQuestions([
    {
      prompt: 'q',
      type: 'single_choice',
      options: ['a', 'z'.repeat(service.MAX_OPTION_LENGTH + 50)],
    },
  ]);
  assert.equal(long.questions[0].options[1].length, service.MAX_OPTION_LENGTH);
});

test('validateQuestions disambiguates duplicate prompts instead of colliding ids', () => {
  const { service } = buildService();
  const parsed = service.validateQuestions([
    { prompt: 'How was it?' },
    { prompt: 'How was it?' },
    { id: 'how_was_it', prompt: 'Different text' },
  ]);
  assert.equal(parsed.questions[0].id, 'how_was_it');
  assert.equal(parsed.questions[1].id, 'how_was_it_2');
  assert.equal(parsed.questions[2].id, 'how_was_it_3');
  assert.equal(new Set(parsed.questions.map(q => q.id)).size, 3);
});

test('validateQuestions keeps an explicit id so published answers stay addressable', () => {
  const { service } = buildService();
  const parsed = service.validateQuestions([{ id: 'legacy_id', prompt: 'Anything?' }]);
  assert.equal(parsed.questions[0].id, 'legacy_id');
});

test('validateAnswers rejects a non-object payload', () => {
  const { service } = buildService();
  for (const bad of [null, undefined, 'x', 5, []]) {
    assert.equal(service.validateAnswers(QUESTIONS, bad).status, 422);
  }
});

test('validateAnswers rejects ids that are not in the question set', () => {
  const { service } = buildService();
  const parsed = service.validateAnswers(QUESTIONS, { delivery: 5, ghost: 'x' });
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /unknown question ids: ghost/);
});

test('validateAnswers enforces required questions', () => {
  const { service } = buildService();
  const parsed = service.validateAnswers(QUESTIONS, { reuse: 'Yes' });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.field, 'answers.delivery');
});

test('validateAnswers range-checks ratings', () => {
  const { service } = buildService();
  for (const value of [0, 6, 2.5, 'high', true]) {
    const parsed = service.validateAnswers(QUESTIONS, { delivery: value, reuse: 'Yes' });
    assert.equal(parsed.ok, false, `${value} must be rejected`);
    assert.equal(parsed.field, 'answers.delivery');
  }
  assert.deepEqual(service.validateAnswers(QUESTIONS, { delivery: 4, reuse: 'Yes' }).answers, {
    delivery: 4,
    reuse: 'Yes',
  });
});

test('validateAnswers checks single-choice answers against the option list', () => {
  const { service } = buildService();
  assert.equal(service.validateAnswers(QUESTIONS, { delivery: 3, reuse: 'Maybe' }).status, 422);
});

test('validateAnswers trims and length-caps free text', () => {
  const { service } = buildService();
  const ok = service.validateAnswers(QUESTIONS, {
    delivery: 3,
    reuse: 'Yes',
    notes: '   great work   ',
  });
  assert.equal(ok.answers.notes, 'great work');

  const tooLong = service.validateAnswers(QUESTIONS, {
    delivery: 3,
    reuse: 'Yes',
    notes: 'x'.repeat(service.MAX_TEXT_ANSWER_LENGTH + 1),
  });
  assert.equal(tooLong.status, 422);
});

test('validateAnswers omits an unanswered optional question', () => {
  const { service } = buildService();
  const parsed = service.validateAnswers(QUESTIONS, { delivery: 5, reuse: 'No' });
  assert.equal('notes' in parsed.answers, false);
});

// ── eligibility ────────────────────────────────────────────────────────────

test('isCampaignEligible only allows post-funding statuses', () => {
  const { service } = buildService();
  for (const status of ['completed', 'funded', 'in_progress', 'closed']) {
    assert.equal(service.isCampaignEligible(status), true, status);
  }
  for (const status of ['active', 'failed', 'suspended', 'disputed', 'withdrawn']) {
    assert.equal(service.isCampaignEligible(status), false, status);
  }
});

// ── create ─────────────────────────────────────────────────────────────────

test('createSurvey 404s for an unknown campaign', async () => {
  const { service } = buildService([['FROM campaigns WHERE id = $1', { rows: [] }]]);
  await assert.rejects(
    () => service.createSurvey({ campaignId: CAMPAIGN_ID, creatorId: USER_ID, title: 'x' }),
    err => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('createSurvey 409s while the campaign is still funding', async () => {
  const { service } = buildService([
    [
      'FROM campaigns WHERE id = $1',
      { rows: [{ id: CAMPAIGN_ID, creator_id: USER_ID, status: 'active' }] },
    ],
  ]);
  await assert.rejects(
    () => service.createSurvey({ campaignId: CAMPAIGN_ID, creatorId: USER_ID, title: 'x' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /current status: "active"/);
      return true;
    }
  );
});

test('createSurvey persists a draft and records a lifecycle event plus an audit row', async () => {
  const { service, calls, audits } = buildService([
    [
      'FROM campaigns WHERE id = $1',
      { rows: [{ id: CAMPAIGN_ID, creator_id: USER_ID, status: 'completed' }] },
    ],
    ['INSERT INTO campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft' })] }],
    ['INSERT INTO campaign_outcome_survey_events', { rows: [] }],
  ]);

  const survey = await service.createSurvey({
    campaignId: CAMPAIGN_ID,
    creatorId: USER_ID,
    title: 'How did it go?',
    questions: [{ prompt: 'Rate the delivery', type: 'rating' }],
  });

  assert.equal(survey.status, 'draft');
  assert.equal(survey.id, SURVEY_ID);

  const insert = calls.find(c => c.sql.includes('INSERT INTO campaign_outcome_surveys'));
  assert.match(insert.sql, /\$5::jsonb/);
  assert.equal(insert.params[0], CAMPAIGN_ID);
  assert.equal(insert.params[1], USER_ID);
  assert.deepEqual(JSON.parse(insert.params[4]), [
    {
      id: 'rate_the_delivery',
      prompt: 'Rate the delivery',
      type: 'rating',
      required: true,
      options: null,
    },
  ]);

  const event = calls.find(c => c.sql.includes('INSERT INTO campaign_outcome_survey_events'));
  assert.ok(event, 'a draft lifecycle event is recorded');
  assert.equal(audits[0].action, 'outcome_survey_created');
});

test('createSurvey surfaces a validation failure with the right status', async () => {
  const { service } = buildService([
    [
      'FROM campaigns WHERE id = $1',
      { rows: [{ id: CAMPAIGN_ID, creator_id: USER_ID, status: 'funded' }] },
    ],
  ]);
  await assert.rejects(
    () => service.createSurvey({ campaignId: CAMPAIGN_ID, creatorId: USER_ID, title: '' }),
    err => {
      assert.equal(err.status, 422);
      return true;
    }
  );
});

// ── update ─────────────────────────────────────────────────────────────────

test('updateSurvey rewrites a draft', async () => {
  const { service, calls } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft' })] }],
    [
      'UPDATE campaign_outcome_surveys',
      { rows: [surveyRow({ status: 'draft', title: 'Updated' })] },
    ],
    ['INSERT INTO campaign_outcome_survey_events', { rows: [] }],
  ]);

  const survey = await service.updateSurvey({
    campaignId: CAMPAIGN_ID,
    actorId: USER_ID,
    title: 'Updated',
    questions: [{ prompt: 'Rate it' }],
  });

  assert.equal(survey.title, 'Updated');
  const update = calls.find(c => c.sql.includes('UPDATE campaign_outcome_surveys'));
  assert.match(update.sql, /WHERE id = \$1 AND status = 'draft'/);
});

test('updateSurvey 409s once the survey is open so in-flight answers are never re-scoped', async () => {
  const { service } = buildService([['FROM campaign_outcome_surveys', { rows: [surveyRow()] }]]);
  await assert.rejects(
    () =>
      service.updateSurvey({ campaignId: CAMPAIGN_ID, title: 'x', questions: [{ prompt: 'y' }] }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /cannot be edited while it is "open"/);
      return true;
    }
  );
});

test('updateSurvey 404s when the campaign has no survey', async () => {
  const { service } = buildService([['FROM campaign_outcome_surveys', { rows: [] }]]);
  await assert.rejects(
    () => service.updateSurvey({ campaignId: CAMPAIGN_ID, title: 'x', questions: [] }),
    err => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('updateSurvey 409s when a concurrent writer already published the draft', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft' })] }],
    ['UPDATE campaign_outcome_surveys', { rows: [] }],
  ]);
  await assert.rejects(
    () =>
      service.updateSurvey({ campaignId: CAMPAIGN_ID, title: 'x', questions: [{ prompt: 'y' }] }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /no longer a draft/);
      return true;
    }
  );
});

// ── open / close ───────────────────────────────────────────────────────────

test('openSurvey publishes the survey and invites backers', async () => {
  const { service, calls, notified, audits } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft' })] }],
    ["SET status = 'open'", { rows: [surveyRow({ status: 'open' })] }],
    ['INSERT INTO campaign_outcome_survey_events', { rows: [] }],
    [
      'JOIN users u ON u.wallet_public_key',
      { rows: [{ id: 'aaaaaaaa-0000-4000-8000-000000000000' }, { id: USER_ID }] },
    ],
  ]);

  const { survey, invited } = await service.openSurvey({
    campaignId: CAMPAIGN_ID,
    actorId: USER_ID,
  });

  assert.equal(survey.status, 'open');
  assert.equal(invited, 1, 'the publishing creator is excluded from their own invite');
  assert.deepEqual(notified[0].userIds, ['aaaaaaaa-0000-4000-8000-000000000000']);
  assert.equal(notified[0].message.link, `/campaigns/${CAMPAIGN_ID}#outcome-survey`);

  const update = calls.find(c => c.sql.includes("SET status = 'open'"));
  assert.match(update.sql, /WHERE id = \$1 AND status = 'draft'/);
  assert.equal(audits[0].action, 'outcome_survey_opened');
  assert.equal(audits[0].metadata.invited, 1);
});

test('openSurvey refuses a draft with no questions', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft', questions: [] })] }],
  ]);
  await assert.rejects(
    () => service.openSurvey({ campaignId: CAMPAIGN_ID, actorId: USER_ID }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /at least one question/);
      return true;
    }
  );
});

test('openSurvey 409s for a survey that is already open', async () => {
  const { service } = buildService([['FROM campaign_outcome_surveys', { rows: [surveyRow()] }]]);
  await assert.rejects(
    () => service.openSurvey({ campaignId: CAMPAIGN_ID, actorId: USER_ID }),
    err => {
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('openSurvey 409s when a concurrent publisher wins the compare-and-set', async () => {
  const { service, notified } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft' })] }],
    ["SET status = 'open'", { rows: [] }],
  ]);
  await assert.rejects(
    () => service.openSurvey({ campaignId: CAMPAIGN_ID, actorId: USER_ID }),
    err => {
      assert.equal(err.status, 409);
      return true;
    }
  );
  assert.equal(notified.length, 0, 'a lost race must not double-notify backers');
});

test('openSurvey rejects a closes_at in the past', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft' })] }],
  ]);
  await assert.rejects(
    () =>
      service.openSurvey({
        campaignId: CAMPAIGN_ID,
        actorId: USER_ID,
        closesAt: '2000-01-01T00:00:00.000Z',
      }),
    err => {
      assert.equal(err.status, 422);
      return true;
    }
  );
});

test('closeSurvey closes an open survey', async () => {
  const { service, calls, audits } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ["SET status = 'closed'", { rows: [surveyRow({ status: 'closed' })] }],
    ['INSERT INTO campaign_outcome_survey_events', { rows: [] }],
  ]);
  const { survey, already_closed: alreadyClosed } = await service.closeSurvey({
    campaignId: CAMPAIGN_ID,
    actorId: USER_ID,
  });
  assert.equal(survey.status, 'closed');
  assert.equal(alreadyClosed, false);
  assert.match(
    calls.find(c => c.sql.includes("SET status = 'closed'")).sql,
    /WHERE id = \$1 AND status = 'open'/
  );
  assert.equal(audits[0].action, 'outcome_survey_closed');
});

test('closeSurvey is idempotent for an already-closed survey', async () => {
  const { service, calls } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'closed' })] }],
  ]);
  const { already_closed: alreadyClosed } = await service.closeSurvey({
    campaignId: CAMPAIGN_ID,
    actorId: USER_ID,
  });
  assert.equal(alreadyClosed, true);
  assert.equal(calls.length, 1, 'no second UPDATE is issued');
});

test('closeSurvey 409s for a draft that was never opened', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft' })] }],
    ["SET status = 'closed'", { rows: [] }],
  ]);
  await assert.rejects(
    () => service.closeSurvey({ campaignId: CAMPAIGN_ID, actorId: USER_ID }),
    err => {
      assert.equal(err.status, 409);
      return true;
    }
  );
});

// ── respond ────────────────────────────────────────────────────────────────

test('submitResponse stores a validated answer set', async () => {
  const { service, calls } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ['FROM contributions c', { rows: [{ 1: 1 }] }],
    ['FROM campaign_outcome_survey_responses', { rows: [] }],
    [
      'INSERT INTO campaign_outcome_survey_responses',
      {
        rows: [
          {
            id: 'resp-1',
            survey_id: SURVEY_ID,
            campaign_id: CAMPAIGN_ID,
            user_id: USER_ID,
            answers: {},
          },
        ],
      },
    ],
  ]);

  const response = await service.submitResponse({
    campaignId: CAMPAIGN_ID,
    userId: USER_ID,
    answers: { delivery: 5, reuse: 'Yes', notes: 'shipped early' },
  });

  assert.equal(response.id, 'resp-1');
  const insert = calls.find(c => c.sql.includes('INSERT INTO campaign_outcome_survey_responses'));
  assert.match(insert.sql, /ON CONFLICT \(survey_id, user_id\) DO NOTHING/);
  assert.deepEqual(JSON.parse(insert.params[3]), {
    delivery: 5,
    reuse: 'Yes',
    notes: 'shipped early',
  });
});

test('submitResponse 404s when the campaign has no survey', async () => {
  const { service } = buildService([['FROM campaign_outcome_surveys', { rows: [] }]]);
  await assert.rejects(
    () => service.submitResponse({ campaignId: CAMPAIGN_ID, userId: USER_ID, answers: {} }),
    err => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('submitResponse 409s for a survey that is not open', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow({ status: 'draft' })] }],
  ]);
  await assert.rejects(
    () => service.submitResponse({ campaignId: CAMPAIGN_ID, userId: USER_ID, answers: {} }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /not accepting responses/);
      return true;
    }
  );
});

test('submitResponse 409s once the close date has passed', async () => {
  const { service } = buildService([
    [
      'FROM campaign_outcome_surveys',
      { rows: [surveyRow({ closes_at: '2000-01-01T00:00:00.000Z' })] },
    ],
  ]);
  await assert.rejects(
    () => service.submitResponse({ campaignId: CAMPAIGN_ID, userId: USER_ID, answers: {} }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /has closed/);
      return true;
    }
  );
});

test('submitResponse 403s for a signed-in user who never backed the campaign', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ['FROM contributions c', { rows: [] }],
  ]);
  await assert.rejects(
    () => service.submitResponse({ campaignId: CAMPAIGN_ID, userId: USER_ID, answers: {} }),
    err => {
      assert.equal(err.status, 403);
      assert.match(err.message, /Only contributors to this campaign/);
      return true;
    }
  );
});

test('submitResponse 409s on a duplicate submission', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ['FROM contributions c', { rows: [{ 1: 1 }] }],
    ['FROM campaign_outcome_survey_responses', { rows: [{ id: 'resp-1' }] }],
  ]);
  await assert.rejects(
    () =>
      service.submitResponse({
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        answers: { delivery: 4, reuse: 'Yes' },
      }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already responded/);
      return true;
    }
  );
});

test('submitResponse 409s when a concurrent duplicate loses the UNIQUE constraint race', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ['FROM contributions c', { rows: [{ 1: 1 }] }],
    ['FROM campaign_outcome_survey_responses', { rows: [] }],
    ['INSERT INTO campaign_outcome_survey_responses', { rows: [] }],
  ]);
  await assert.rejects(
    () =>
      service.submitResponse({
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        answers: { delivery: 4, reuse: 'Yes' },
      }),
    err => {
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('submitResponse 422s before the ownership check when the answers are malformed', async () => {
  // Malformed input is rejected before the beneficiary lookup so an invalid
  // payload cannot be used to probe who contributed to a campaign.
  const { service, calls } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ['FROM contributions c', { rows: [{ 1: 1 }] }],
    ['FROM campaign_outcome_survey_responses', { rows: [] }],
  ]);
  await assert.rejects(
    () => service.submitResponse({ campaignId: CAMPAIGN_ID, userId: USER_ID, answers: 'nope' }),
    err => {
      assert.equal(err.status, 422);
      return true;
    }
  );
  assert.equal(
    calls.some(c => c.sql.includes('INSERT INTO campaign_outcome_survey_responses')),
    false
  );
});

// ── read models ────────────────────────────────────────────────────────────

test('getPublicSurvey reports no survey as a null payload rather than throwing', async () => {
  const { service } = buildService([['FROM campaign_outcome_surveys', { rows: [] }]]);
  const payload = await service.getPublicSurvey(CAMPAIGN_ID);
  assert.deepEqual(payload, { survey: null, response_count: 0, my_response: null });
});

test('getPublicSurvey returns the aggregate count and the caller own response', async () => {
  const { service, calls } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ['COUNT(*)::int AS total', { rows: [{ total: 12 }] }],
    [
      'FROM campaign_outcome_survey_responses',
      { rows: [{ id: 'resp-1', answers: { delivery: 4 } }] },
    ],
  ]);

  const payload = await service.getPublicSurvey(CAMPAIGN_ID, USER_ID);
  assert.equal(payload.response_count, 12);
  assert.equal(payload.my_response.id, 'resp-1');
  assert.deepEqual(payload.my_response.answers, { delivery: 4 });
  // The only per-respondent lookup is scoped to the caller by user id, so no
  // other backer's answers are ever selected.
  const responseQuery = calls.find(
    c => c.sql.includes('FROM campaign_outcome_survey_responses') && c.sql.includes('user_id = $2')
  );
  assert.deepEqual(responseQuery.params, [SURVEY_ID, USER_ID]);
});

test('getPublicSurvey omits my_response for an anonymous viewer', async () => {
  const { service, calls } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ['COUNT(*)::int AS total', { rows: [{ total: 0 }] }],
  ]);
  const payload = await service.getPublicSurvey(CAMPAIGN_ID, null);
  assert.equal(payload.my_response, null);
  assert.equal(calls.length, 2, 'no third query for an anonymous viewer');
});

test('getResults aggregates ratings, choices and free text without exposing respondents', async () => {
  const { service, calls } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    [
      'SELECT answers\n     FROM campaign_outcome_survey_responses',
      {
        rows: [
          { answers: { delivery: 5, reuse: 'Yes', notes: 'great' } },
          { answers: { delivery: 3, reuse: 'No' } },
          { answers: { delivery: 4, reuse: 'Yes', notes: 'great' } },
        ],
      },
    ],
  ]);

  const { response_count: responseCount, results } = await service.getResults(CAMPAIGN_ID);
  assert.equal(responseCount, 3);

  const rating = results.find(r => r.question_id === 'delivery');
  assert.equal(rating.answered, 3);
  assert.equal(rating.average_rating, 4);
  assert.deepEqual(rating.distribution, { 3: 1, 4: 1, 5: 1 });

  const choice = results.find(r => r.question_id === 'reuse');
  assert.equal(choice.answered, 3);
  assert.deepEqual(choice.distribution, { Yes: 2, No: 1 });

  const text = results.find(r => r.question_id === 'notes');
  assert.equal(text.answered, 2);
  assert.equal(text.skipped, 1);
  assert.deepEqual(text.distribution, { great: 2 });
  assert.ok(!('user_id' in text), 'results never carry a respondent id');

  // The aggregation query selects the answer bag only — never the respondent.
  const select = calls.find(c => c.sql.includes('SELECT answers'));
  assert.equal(select.sql.includes('user_id'), false);
});

test('getResults caps the retained free-text samples', async () => {
  const { service } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    [
      'SELECT answers',
      {
        rows: Array.from({ length: 25 }, () => ({
          answers: { delivery: 5, reuse: 'Yes', notes: 'unique' },
        })),
      },
    ],
  ]);
  const { results } = await service.getResults(CAMPAIGN_ID);
  const text = results.find(r => r.question_id === 'notes');
  assert.equal(text.sample_responses.length, 20);
  assert.equal(text.answered, 25);
});

test('getResults 404s when the campaign has no survey', async () => {
  const { service } = buildService([['FROM campaign_outcome_surveys', { rows: [] }]]);
  await assert.rejects(
    () => service.getResults(CAMPAIGN_ID),
    err => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('listEvents returns [] when there is no survey', async () => {
  const { service } = buildService([['FROM campaign_outcome_surveys', { rows: [] }]]);
  assert.deepEqual(await service.listEvents(CAMPAIGN_ID), []);
});

test('listEvents orders the lifecycle trail by time', async () => {
  const { service, calls } = buildService([
    ['FROM campaign_outcome_surveys', { rows: [surveyRow()] }],
    ['FROM campaign_outcome_survey_events', { rows: [{ to_status: 'open' }] }],
  ]);
  const events = await service.listEvents(CAMPAIGN_ID);
  assert.equal(events.length, 1);
  assert.match(calls[1].sql, /ORDER BY created_at ASC/);
});

test('isBeneficiary derives eligibility from the contribution ledger', async () => {
  const { service, calls } = buildService([['FROM contributions c', { rows: [{ 1: 1 }] }]]);
  assert.equal(await service.isBeneficiary(CAMPAIGN_ID, USER_ID), true);
  assert.match(calls[0].sql, /JOIN users u ON u\.wallet_public_key = c\.sender_public_key/);
  assert.match(calls[0].sql, /c\.campaign_id = \$1 AND u\.id = \$2/);
});

test('notifyBackers swallows a notification failure so publishing still succeeds', async () => {
  const { service } = buildService(
    [
      [
        'JOIN users u ON u.wallet_public_key',
        { rows: [{ id: 'aaaaaaaa-0000-4000-8000-000000000000' }] },
      ],
    ],
    { notificationsThrow: true }
  );
  assert.equal(await service.notifyBackers(surveyRow(), USER_ID), 0);
});

test('TRANSITIONS is a closed state machine (nothing reopens a survey)', () => {
  const { service } = buildService();
  assert.deepEqual(service.TRANSITIONS.draft, ['open', 'closed']);
  assert.deepEqual(service.TRANSITIONS.open, ['closed']);
  assert.deepEqual(service.TRANSITIONS.closed, []);
});
