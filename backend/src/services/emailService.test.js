const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { buildUnsubscribeUrl, verifyUnsubscribeToken } = require('../utils/unsubscribeToken');

function buildService({ queryImpl, logger, verifyImpl } = {}) {
  const sent = [];
  const dedupeKeys = new Set();
  const db = {
    query: async (text, params) => {
      if (queryImpl) {
        const result = await queryImpl(text, params);
        if (result !== undefined) return result;
      }
      if (text.includes('INSERT INTO sent_emails')) {
        const key = params[0];
        if (dedupeKeys.has(key)) return { rows: [] };
        dedupeKeys.add(key);
        return { rows: [{ id: 'sent-1' }] };
      }
      if (text.includes('SELECT id FROM users WHERE email = $1')) {
        return { rows: [{ id: 'user-123' }] };
      }
      if (text.includes('FROM notification_preferences')) {
        return { rows: [{ marketing: true }] };
      }
      if (text.includes('FROM email_unsubscribes')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const nodemailerStub = {
    createTransport: () => ({
      sendMail: async mail => {
        sent.push(mail);
      },
      verify:
        verifyImpl ||
        (cb => {
          if (typeof cb === 'function') cb(null, true);
          return Promise.resolve(true);
        }),
    }),
  };

  const service = proxyquire('./emailService', {
    nodemailer: nodemailerStub,
    '../config/database': db,
    ...(logger ? { '../config/logger': logger } : {}),
  });

  return { service, sent, db };
}

test('sendWelcomeEmail sends html and text and is idempotent per recipient', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  const { service, sent } = buildService({
    queryImpl: (text, params) => {
      if (text.includes('notification_preferences')) {
        return { rows: [{ marketing: true }] };
      }
      return undefined;
    },
  });

  await service.sendWelcomeEmail({ to: 'a@test.com', name: 'Alice', walletPublicKey: 'GPK' });
  await service.sendWelcomeEmail({ to: 'a@test.com', name: 'Alice', walletPublicKey: 'GPK' });

  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Welcome/);
  assert.ok(sent[0].html.includes('Alice'));
  assert.ok(sent[0].text.includes('Alice'));

  // Contains valid unsubscribe link
  assert.ok(sent[0].html.includes('/settings/notifications'));

  delete process.env.SMTP_HOST;
});

test('per-category send gating: respects preferences in notification_preferences', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  const { service, sent } = buildService({
    queryImpl: (text, params) => {
      if (text.includes('notification_preferences')) {
        return { rows: [{ campaign_updates: false }] }; // Unsubscribed
      }
      return undefined;
    },
  });

  // Since campaign_updates is false, it shouldn't send
  await service.sendTeamMemberInvitedEmail({ to: 'invited@test.com', memberId: 'm-1' });

  assert.equal(sent.length, 0);
  delete process.env.SMTP_HOST;
});

test('default values: marketing is off by default when no preferences exist', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  const { service, sent } = buildService({
    queryImpl: (text, params) => {
      if (text.includes('notification_preferences')) {
        return { rows: [] }; // No preferences yet
      }
      return undefined;
    },
  });

  // Welcome email is marketing, should be skipped
  await service.sendWelcomeEmail({ to: 'new@test.com', name: 'Bob', walletPublicKey: 'GPK' });
  assert.equal(sent.length, 0);

  // Team invite is campaign_update, should be sent
  await service.sendTeamMemberInvitedEmail({ to: 'invited@test.com', memberId: 'm-1' });
  assert.equal(sent.length, 1);

  delete process.env.SMTP_HOST;
});

test('unsubscribe token validation works', async () => {
  const url = buildUnsubscribeUrl({ email: 'test@test.com', category: 'refund' });
  const sig = url.split('sig=')[1].split('&')[0];
  const isValid = verifyUnsubscribeToken({ email: 'test@test.com', category: 'refund', sig });
  assert.equal(isValid, true);

  const isInvalid = verifyUnsubscribeToken({
    email: 'test@test.com',
    category: 'refund',
    sig: 'fake',
  });
  assert.equal(isInvalid, false);
});

function unconfiguredEnv() {
  const saved = {
    SMTP_HOST: process.env.SMTP_HOST,
    EMAIL_SERVICE_API_KEY: process.env.EMAIL_SERVICE_API_KEY,
    DISABLE_EMAILS: process.env.DISABLE_EMAILS,
  };
  delete process.env.SMTP_HOST;
  delete process.env.EMAIL_SERVICE_API_KEY;
  delete process.env.DISABLE_EMAILS;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test('unconfigured: warns only once per process and reports not configured', async () => {
  const restore = unconfiguredEnv();
  try {
    const warns = [];
    const { service } = buildService({
      logger: { info: () => {}, error: () => {}, warn: m => warns.push(m) },
    });
    assert.equal(service.isEmailConfigured(), false);
    await service.sendEmail({ to: 'a@test.com', subject: 's1' });
    await service.sendEmail({ to: 'a@test.com', subject: 's2' });
    assert.equal(warns.length, 1);
  } finally {
    restore();
  }
});

test('unconfigured: sendIdempotent does not write a sent_emails row', async () => {
  const restore = unconfiguredEnv();
  try {
    const inserts = [];
    const { service } = buildService({
      logger: { info: () => {}, error: () => {}, warn: () => {} },
      queryImpl: text => {
        if (text.includes('INSERT INTO sent_emails')) inserts.push(text);
        return undefined;
      },
    });
    await service.sendIdempotent({
      dedupeKey: 'k1',
      to: 'a@test.com',
      subject: 's',
      text: 't',
      html: 'h',
    });
    assert.equal(inserts.length, 0);
  } finally {
    restore();
  }
});

test('configured: isEmailConfigured is true and sendIdempotent still dedupes', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const { service, sent } = buildService();
    assert.equal(service.isEmailConfigured(), true);
    const mail = { dedupeKey: 'k2', to: 'a@test.com', subject: 's', text: 't', html: 'h' };
    await service.sendIdempotent(mail);
    await service.sendIdempotent(mail);
    assert.equal(sent.length, 1);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('verifyEmailTransport: verifies successfully when transport connects', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const { service } = buildService({
      verifyImpl: cb => {
        if (typeof cb === 'function') cb(null, true);
        return Promise.resolve(true);
      },
    });
    const result = await service.verifyEmailTransport();
    assert.ok(result);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('verifyEmailTransport: throws when transport connection fails', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const { service } = buildService({
      verifyImpl: cb => {
        const err = new Error('SMTP connection refused');
        if (typeof cb === 'function') cb(err);
        return Promise.reject(err);
      },
    });
    await assert.rejects(async () => {
      await service.verifyEmailTransport();
    }, /SMTP connection refused/);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('verifyEmailTransport: rejects when email is unconfigured', async () => {
  const service = proxyquire('./emailService', {
    nodemailer: { createTransport: () => ({ sendMail: async () => {} }) },
    '../config/database': { query: async () => ({ rows: [] }) },
  });
  await assert.rejects(async () => {
    await service.verifyEmailTransport();
  }, /Email transport is not configured/);
});

test('verifyEmailTransport: returns disabled: true when emailsDisabled is true', async () => {
  process.env.DISABLE_EMAILS = 'true';
  try {
    const service = proxyquire('./emailService', {
      nodemailer: { createTransport: () => ({ sendMail: async () => {} }) },
      '../config/database': { query: async () => ({ rows: [] }) },
    });
    const result = await service.verifyEmailTransport();
    assert.deepEqual(result, { disabled: true });
  } finally {
    delete process.env.DISABLE_EMAILS;
  }
});

// ---------------------------------------------------------------------------
// Notification preference filtering
// ---------------------------------------------------------------------------

test('isUnsubscribed: returns false when user is not found and lowercases email', async () => {
  const queries = [];
  const { service } = buildService({
    queryImpl: (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT id FROM users WHERE email = $1')) {
        return { rows: [] };
      }
      return undefined;
    },
  });

  const result = await service.isUnsubscribed('Alice@Example.COM', 'marketing');
  assert.equal(result, false);
  assert.equal(queries[0].params[0], 'alice@example.com');
});

test('isUnsubscribed: maps all notification categories and defaults unknown to campaign_updates', async () => {
  const prefs = {
    marketing: false,
    campaign_updates: true,
    refunds: false,
    milestones: true,
    disputes: false,
    category_digest: false,
  };
  const { service } = buildService({
    queryImpl: text => {
      if (text.includes('FROM notification_preferences')) {
        return { rows: [prefs] };
      }
      return undefined;
    },
  });

  assert.equal(await service.isUnsubscribed('u@test.com', 'marketing'), true);
  assert.equal(await service.isUnsubscribed('u@test.com', 'weekly_digest'), true);
  assert.equal(await service.isUnsubscribed('u@test.com', 'campaign_update'), false);
  assert.equal(await service.isUnsubscribed('u@test.com', 'refund'), true);
  assert.equal(await service.isUnsubscribed('u@test.com', 'milestone'), false);
  assert.equal(await service.isUnsubscribed('u@test.com', 'dispute'), true);
  assert.equal(await service.isUnsubscribed('u@test.com', 'category_digest'), true);
  assert.equal(await service.isUnsubscribed('u@test.com', 'unknown_category'), false);
});

test('isUnsubscribed: falls back on pre-migration 42703 error and treats missing category_digest as subscribed', async () => {
  let prefCalls = 0;
  const { service } = buildService({
    queryImpl: text => {
      if (text.includes('SELECT * FROM notification_preferences')) {
        prefCalls += 1;
        const err = new Error('column category_digest does not exist');
        err.code = '42703';
        throw err;
      }
      if (text.includes('SELECT user_id, campaign_updates')) {
        prefCalls += 1;
        return {
          rows: [
            {
              user_id: 'user-123',
              campaign_updates: true,
              refunds: true,
              disputes: false,
              milestones: true,
              marketing: false,
            },
          ],
        };
      }
      return undefined;
    },
  });

  assert.equal(await service.isUnsubscribed('u@test.com', 'category_digest'), false);
  assert.equal(await service.isUnsubscribed('u@test.com', 'dispute'), true);
  assert.equal(prefCalls, 4);
});

test('isUnsubscribed: rethrows non-42703 database errors', async () => {
  const { service } = buildService({
    queryImpl: text => {
      if (text.includes('SELECT * FROM notification_preferences')) {
        const err = new Error('connection terminated');
        err.code = '08006';
        throw err;
      }
      return undefined;
    },
  });

  await assert.rejects(
    () => service.isUnsubscribed('u@test.com', 'campaign_update'),
    /connection terminated/
  );
});

test('sendCampaignUpdatePostedEmail: respects per-campaign unsubscribe even when globally subscribed', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const { service, sent } = buildService({
      queryImpl: (text, params) => {
        if (text.includes('FROM notification_preferences')) {
          return { rows: [{ campaign_updates: true }] };
        }
        if (text.includes('FROM campaign_update_unsubscribes')) {
          return { rows: params[1] === 'camp-unsub' ? [{ '?column?': 1 }] : [] };
        }
        return undefined;
      },
    });

    await service.sendCampaignUpdatePostedEmail({
      to: 'backer@test.com',
      updateId: 'upd-1',
      campaignId: 'camp-unsub',
      campaignTitle: 'Solar Grid',
      updateTitle: 'Progress',
      updateBody: 'Details',
    });
    assert.equal(sent.length, 0);

    await service.sendCampaignUpdatePostedEmail({
      to: 'backer@test.com',
      updateId: 'upd-2',
      campaignId: 'camp-ok',
      campaignTitle: 'Solar Grid',
      updateTitle: 'Progress',
      updateBody: 'Details',
    });
    assert.equal(sent.length, 1);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('sendThankYouEmail: skips when thank-you unsubscribed and sends otherwise', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const { service, sent } = buildService({
      queryImpl: (text, params) => {
        if (text.includes('FROM thank_you_unsubscribes')) {
          return { rows: params[1] === 'camp-muted' ? [{ '?column?': 1 }] : [] };
        }
        return undefined;
      },
    });

    await service.sendThankYouEmail({
      to: 'donor@test.com',
      messageId: 'msg-1',
      campaignId: 'camp-muted',
      donorName: 'Dana',
      campaignTitle: 'Clean Water',
      message: 'Thanks!',
    });
    assert.equal(sent.length, 0);

    await service.sendThankYouEmail({
      to: 'donor@test.com',
      messageId: 'msg-2',
      campaignId: 'camp-open',
      donorName: 'Dana',
      campaignTitle: 'Clean Water',
      message: 'Thanks!',
    });
    assert.equal(sent.length, 1);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('sendContributionReceipt: filters by DISABLE_EMAILS, missing user/campaign, and refund preference', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    let userRows = [{ email: 'payer@test.com', name: 'Pat' }];
    let campaignRows = [{ title: 'Open Clinic' }];
    let refundPref = false;

    const { service, sent } = buildService({
      queryImpl: text => {
        if (text.includes('SELECT email, name FROM users')) return { rows: userRows };
        if (text.includes('SELECT title FROM campaigns')) return { rows: campaignRows };
        if (text.includes('FROM notification_preferences')) {
          return { rows: [{ refunds: refundPref }] };
        }
        return undefined;
      },
    });

    // Unsubscribed from refund category -> skipped
    await service.sendContributionReceipt({
      campaignId: 'c-1',
      txHash: 'tx-1',
      amount: '50',
      asset: 'USDC',
      senderPublicKey: 'GPK1',
    });
    assert.equal(sent.length, 0);

    // Missing campaign -> skipped
    refundPref = true;
    campaignRows = [];
    await service.sendContributionReceipt({
      campaignId: 'c-missing',
      txHash: 'tx-2',
      amount: '50',
      asset: 'USDC',
      senderPublicKey: 'GPK1',
    });
    assert.equal(sent.length, 0);

    // Missing user -> skipped
    campaignRows = [{ title: 'Open Clinic' }];
    userRows = [];
    await service.sendContributionReceipt({
      campaignId: 'c-1',
      txHash: 'tx-3',
      amount: '50',
      asset: 'USDC',
      senderPublicKey: 'GPK-NONE',
    });
    assert.equal(sent.length, 0);

    // All present and subscribed -> sent once (deduped by txHash)
    userRows = [{ email: 'payer@test.com', name: 'Pat' }];
    await service.sendContributionReceipt({
      campaignId: 'c-1',
      txHash: 'tx-4',
      amount: '50',
      asset: 'USDC',
      senderPublicKey: 'GPK1',
    });
    await service.sendContributionReceipt({
      campaignId: 'c-1',
      txHash: 'tx-4',
      amount: '50',
      asset: 'USDC',
      senderPublicKey: 'GPK1',
    });
    assert.equal(sent.length, 1);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('sendRecurringContributionNoticeEmail: handles upcoming/charged/failed and ignores invalid kind', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const { service, sent } = buildService({
      queryImpl: text => {
        if (text.includes('FROM notification_preferences')) {
          return { rows: [{ campaign_updates: true }] };
        }
        return undefined;
      },
    });

    await service.sendRecurringContributionNoticeEmail({
      to: 'sub@test.com',
      kind: 'invalid_kind',
      recurringRunKey: 'run-0',
      campaignTitle: 'Monthly Aid',
    });
    assert.equal(sent.length, 0);

    for (const kind of ['upcoming', 'charged', 'failed']) {
      await service.sendRecurringContributionNoticeEmail({
        to: 'sub@test.com',
        kind,
        recurringRunKey: `run-${kind}`,
        campaignTitle: 'Monthly Aid',
        amount: '10',
        asset: 'USDC',
      });
    }
    assert.equal(sent.length, 3);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('category gating for dispute, milestone, and weekly_digest emails', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const { service, sent } = buildService({
      queryImpl: text => {
        if (text.includes('FROM notification_preferences')) {
          return { rows: [{ disputes: false, milestones: false, marketing: false }] };
        }
        return undefined;
      },
    });

    await service.sendDisputeOpenedCreatorEmail({
      to: 'creator@test.com',
      disputeId: 'd-1',
      campaignTitle: 'Test',
    });
    await service.sendWithdrawalApprovedEmail({
      to: 'creator@test.com',
      withdrawalId: 'w-1',
      campaignTitle: 'Test',
    });
    await service.sendWeeklyDigestEmail({
      to: 'user@test.com',
      userId: 'u-1',
      windowEnd: new Date('2026-01-01T00:00:00Z'),
    });

    assert.equal(sent.length, 0);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

// ---------------------------------------------------------------------------
// Provider configuration & fallback
// ---------------------------------------------------------------------------

test('provider fallback: uses SendGrid defaults when only EMAIL_SERVICE_API_KEY is set', async () => {
  const restore = unconfiguredEnv();
  process.env.EMAIL_SERVICE_API_KEY = 'sg-secret-key';
  try {
    let capturedConfig;
    const sent = [];
    const service = proxyquire('./emailService', {
      nodemailer: {
        createTransport: config => {
          capturedConfig = config;
          return {
            sendMail: async mail => {
              sent.push(mail);
            },
          };
        },
      },
      '../config/database': { query: async () => ({ rows: [] }) },
    });

    assert.equal(service.isEmailConfigured(), true);
    assert.equal(capturedConfig.host, 'smtp.sendgrid.net');
    assert.equal(capturedConfig.port, 587);
    assert.equal(capturedConfig.secure, false);
    assert.equal(capturedConfig.auth.user, 'apikey');
    assert.equal(capturedConfig.auth.pass, 'sg-secret-key');

    await service.sendEmail({ to: 'a@test.com', subject: 'Hello', text: 'Body' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, '"CrowdPay" <noreply@crowdpay.local>');
  } finally {
    restore();
  }
});

test('DISABLE_EMAILS=true disables transport even when SMTP_HOST is set', async () => {
  const restore = unconfiguredEnv();
  process.env.SMTP_HOST = 'smtp.test';
  process.env.DISABLE_EMAILS = 'true';
  try {
    const infos = [];
    let sendCalled = false;
    const service = proxyquire('./emailService', {
      nodemailer: {
        createTransport: () => ({
          sendMail: async () => {
            sendCalled = true;
          },
        }),
      },
      '../config/database': { query: async () => ({ rows: [] }) },
      '../config/logger': {
        info: msg => infos.push(msg),
        warn: () => {},
        error: () => {},
      },
    });

    assert.equal(service.isEmailConfigured(), false);
    await service.sendEmail({ to: 'a@test.com', subject: 'Suppressed' });
    assert.equal(sendCalled, false);
    assert.equal(infos.length, 1);
  } finally {
    restore();
  }
});

test('verifyEmailTransport: resolves true when transporter has no verify method and rejects on sync throw', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const noVerifyService = proxyquire('./emailService', {
      nodemailer: { createTransport: () => ({ sendMail: async () => {} }) },
      '../config/database': { query: async () => ({ rows: [] }) },
    });
    assert.equal(await noVerifyService.verifyEmailTransport(), true);

    const syncThrowService = proxyquire('./emailService', {
      nodemailer: {
        createTransport: () => ({
          sendMail: async () => {},
          verify: () => {
            throw new Error('sync verify boom');
          },
        }),
      },
      '../config/database': { query: async () => ({ rows: [] }) },
    });
    await assert.rejects(() => syncThrowService.verifyEmailTransport(), /sync verify boom/);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

// ---------------------------------------------------------------------------
// Delivery errors & dedupe rollback
// ---------------------------------------------------------------------------

test('sendEmail: logs error and rethrows when transporter.sendMail fails', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const errors = [];
    const service = proxyquire('./emailService', {
      nodemailer: {
        createTransport: () => ({
          sendMail: async () => {
            throw new Error('SMTP 421 service unavailable');
          },
        }),
      },
      '../config/database': { query: async () => ({ rows: [] }) },
      '../config/logger': {
        info: () => {},
        warn: () => {},
        error: (msg, meta) => errors.push({ msg, meta }),
      },
    });

    await assert.rejects(
      () => service.sendEmail({ to: 'a@test.com', subject: 'Fail test', text: 'Hi' }),
      /SMTP 421 service unavailable/
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0].meta.err, 'SMTP 421 service unavailable');
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('sendIdempotent: releases dedupe claim when delivery fails so retry can succeed', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const dedupeKeys = new Set();
    let attempt = 0;
    const sent = [];

    const service = proxyquire('./emailService', {
      nodemailer: {
        createTransport: () => ({
          sendMail: async mail => {
            attempt += 1;
            if (attempt === 1) throw new Error('transient SMTP timeout');
            sent.push(mail);
          },
        }),
      },
      '../config/database': {
        query: async (text, params) => {
          if (text.includes('INSERT INTO sent_emails')) {
            if (dedupeKeys.has(params[0])) return { rows: [] };
            dedupeKeys.add(params[0]);
            return { rows: [{ id: 'row-1' }] };
          }
          if (text.includes('DELETE FROM sent_emails')) {
            dedupeKeys.delete(params[0]);
            return { rows: [] };
          }
          return { rows: [] };
        },
      },
      '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
    });

    const mail = { dedupeKey: 'retry-key', to: 'a@test.com', subject: 'Retry', text: 't', html: 'h' };
    await assert.rejects(() => service.sendIdempotent(mail), /transient SMTP timeout/);
    assert.equal(dedupeKeys.has('retry-key'), false);

    // Retry should succeed now that the dedupe key was released
    await service.sendIdempotent(mail);
    assert.equal(sent.length, 1);
    assert.equal(dedupeKeys.has('retry-key'), true);
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('sendIdempotent: rethrows original send error even if dedupe cleanup query fails', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    const errors = [];
    const service = proxyquire('./emailService', {
      nodemailer: {
        createTransport: () => ({
          sendMail: async () => {
            throw new Error('primary send error');
          },
        }),
      },
      '../config/database': {
        query: async text => {
          if (text.includes('INSERT INTO sent_emails')) return { rows: [{ id: 'row-1' }] };
          if (text.includes('DELETE FROM sent_emails')) throw new Error('db cleanup failed');
          return { rows: [] };
        },
      },
      '../config/logger': {
        info: () => {},
        warn: () => {},
        error: (msg, meta) => errors.push({ msg, meta }),
      },
    });

    await assert.rejects(
      () =>
        service.sendIdempotent({
          dedupeKey: 'cleanup-fail-key',
          to: 'a@test.com',
          subject: 's',
          text: 't',
          html: 'h',
        }),
      /primary send error/
    );
    assert.ok(errors.some(e => e.msg.includes('Failed to release email dedupe claim')));
  } finally {
    delete process.env.SMTP_HOST;
  }
});

test('sendIdempotent: returns early when recipient is missing', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  try {
    let queryCalled = false;
    const { service, sent } = buildService({
      queryImpl: () => {
        queryCalled = true;
        return { rows: [] };
      },
    });
    await service.sendIdempotent({ dedupeKey: 'no-to', to: '', subject: 's' });
    assert.equal(queryCalled, false);
    assert.equal(sent.length, 0);
  } finally {
    delete process.env.SMTP_HOST;
  }
});
