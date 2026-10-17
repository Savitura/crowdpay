const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const notificationRow = {
  id: 'gift-1',
  campaign_id: 'campaign-1',
  contribution_id: 'contribution-1',
  recipient_email: 'recipient@example.com',
  recipient_name: 'Ada',
  message: 'Enjoy supporting this project!',
  amount: '12.5',
  asset: 'XLM',
  campaign_title: 'Open source tools',
  attempts: 1,
};

function buildService({ query, sendEmail = async () => {}, createNotification = async () => {} } = {}) {
  return proxyquire('./contributionGiftNotifications', {
    '../config/database': { query: query || (async () => ({ rows: [] })) },
    '../config/logger': { error: () => {} },
    './emailService': { sendEmail, isEmailConfigured: () => true },
    './notifications': { createNotification },
  });
}

test('delivers a confirmed gift email and in-app notice, then marks its outbox row sent', async () => {
  const queries = [];
  let sentEmail;
  let inAppNotice;
  const service = buildService({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('WITH candidates')) return { rows: [notificationRow] };
      if (sql.includes('SELECT id FROM users')) return { rows: [{ id: 'user-2' }] };
      return { rows: [] };
    },
    sendEmail: async email => { sentEmail = email; },
    createNotification: async (userId, notice) => { inAppNotice = { userId, notice }; },
  });

  await service.processPendingGiftNotifications();

  assert.equal(sentEmail.to, 'recipient@example.com');
  assert.match(sentEmail.text, /in your honor/);
  assert.match(sentEmail.text, /Enjoy supporting this project/);
  assert.equal(inAppNotice.userId, 'user-2');
  assert.equal(inAppNotice.notice.type, 'gift_contribution');
  assert.ok(queries.some(({ sql }) => /SET status = 'sent'/.test(sql)));
});

test('requeues failed gift email delivery with bounded exponential backoff', async () => {
  const queries = [];
  const service = buildService({
    query: async (sql, params) => {
      queries.push({ sql, params });
      return sql.includes('WITH candidates') ? { rows: [{ ...notificationRow, attempts: 2 }] } : { rows: [] };
    },
    sendEmail: async () => { throw new Error('SMTP unavailable'); },
  });

  await service.processPendingGiftNotifications();

  const retry = queries.find(({ sql }) => /SET status = 'pending'/.test(sql));
  assert.ok(retry);
  assert.equal(retry.params[1], 120);
  assert.equal(retry.params[2], 'SMTP unavailable');
  assert.equal(service.retryDelaySeconds(99), 86400);
});
