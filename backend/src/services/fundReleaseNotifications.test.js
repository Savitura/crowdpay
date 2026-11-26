const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function loadService({ contributors, notifyError, emailError } = {}) {
  const notifications = [];
  const emails = [];
  const errors = [];
  const queries = [];

  const service = proxyquire('./fundReleaseNotifications', {
    '../config/database': {
      query: async (text, params) => {
        queries.push({ text, params });
        return { rows: contributors || [] };
      },
    },
    '../config/logger': {
      info: () => {},
      error: (message, meta) => errors.push({ message, meta }),
      warn: () => {},
    },
    './notifications': {
      createNotification: async (userId, message) => {
        if (notifyError && notifyError(userId)) throw new Error('channel down');
        notifications.push({ userId, message });
      },
    },
    './emailService': {
      sendContributorFundsReleasedEmail: async payload => {
        if (emailError && emailError(payload)) throw new Error('smtp down');
        emails.push(payload);
      },
    },
  });

  return { service, notifications, emails, errors, queries };
}

const contributors = [
  { id: 'user-1', email: 'ada@example.com', name: 'Ada' },
  { id: 'user-2', email: 'grace@example.com', name: 'Grace' },
  { id: 'user-3', email: null, name: 'No Mail' },
];

test('buildMessage includes usage and the transaction when they are present', () => {
  const { service } = loadService();
  const message = service.buildMessage({
    campaignId: 'camp-1',
    campaignTitle: 'Solar Garden',
    amount: '100',
    asset: 'USDC',
    usage: 'milestone 1',
    txHash: 'tx-1',
  });

  assert.equal(message.type, 'funds_released');
  assert.equal(message.title, 'Solar Garden: funds released');
  assert.equal(message.link, '/campaigns/camp-1');
  assert.match(message.body, /100 USDC was released/);
  assert.match(message.body, /Usage: milestone 1/);
  assert.match(message.body, /Transaction: tx-1/);
});

test('buildMessage omits empty usage and transaction details', () => {
  const { service } = loadService();
  const message = service.buildMessage({
    campaignId: 'camp-1',
    campaignTitle: 'Solar Garden',
    amount: '5',
    asset: 'XLM',
  });

  assert.equal(message.body, '5 XLM was released from this campaign.');
});

test('notifyContributorFundRelease dispatches in-app channels and a deduped email', async () => {
  const { service, notifications, emails, queries } = loadService({ contributors });
  const notified = await service.notifyContributorFundRelease({
    campaignId: 'camp-1',
    campaignTitle: 'Solar Garden',
    amount: '100',
    asset: 'USDC',
    txHash: 'tx-1',
    usage: 'parts',
    recipient: 'GCREATOR',
    excludeUserIds: ['user-2', null],
  });

  assert.equal(notified, 2);
  assert.match(queries[0].text, /DISTINCT ON/);
  assert.deepEqual(queries[0].params, ['camp-1']);
  assert.deepEqual(
    notifications.map(item => item.userId),
    ['user-1', 'user-3']
  );
  assert.equal(notifications[0].message.type, 'funds_released');
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'ada@example.com');
  assert.equal(emails[0].dedupeKey, 'funds_released:camp-1:tx-1:user-1');
  const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  assert.equal(emails[0].campaignUrl, `${frontendBase}/campaigns/camp-1`);
  assert.equal(emails[0].recipient, 'GCREATOR');
});

test('notifyContributorFundRelease uses a stable dedupe key when there is no transaction hash', async () => {
  const { service, emails } = loadService({
    contributors: [{ id: 'user-1', email: 'ada@example.com', name: 'Ada' }],
  });

  await service.notifyContributorFundRelease({
    campaignId: 'camp-1',
    campaignTitle: 'Solar Garden',
    amount: '1',
    asset: 'XLM',
  });

  assert.equal(emails[0].dedupeKey, 'funds_released:camp-1:no-tx:user-1');
});

test('notifyContributorFundRelease continues when one channel dispatch fails', async () => {
  const { service, notifications, emails, errors } = loadService({
    contributors,
    notifyError: userId => userId === 'user-1',
  });

  const notified = await service.notifyContributorFundRelease({
    campaignId: 'camp-1',
    campaignTitle: 'Solar Garden',
    amount: '10',
    asset: 'USDC',
    txHash: 'tx-9',
  });

  assert.equal(notified, 2);
  assert.deepEqual(
    notifications.map(item => item.userId),
    ['user-2', 'user-3']
  );
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'grace@example.com');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].meta.user_id, 'user-1');
});

test('notifyContributorFundRelease counts only successful dispatches when email fails', async () => {
  const { service, errors } = loadService({
    contributors: [{ id: 'user-1', email: 'ada@example.com', name: 'Ada' }],
    emailError: () => true,
  });

  const notified = await service.notifyContributorFundRelease({
    campaignId: 'camp-1',
    campaignTitle: 'Solar Garden',
    amount: '10',
    asset: 'USDC',
    txHash: 'tx-9',
  });

  assert.equal(notified, 0);
  assert.equal(errors[0].meta.error, 'smtp down');
});
