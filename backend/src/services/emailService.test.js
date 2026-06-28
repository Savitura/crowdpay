const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService({ queryImpl } = {}) {
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
      if (text.includes('FROM email_unsubscribes')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const nodemailerStub = {
    createTransport: () => ({
      sendMail: async (mail) => {
        sent.push(mail);
      },
    }),
  };

  const service = proxyquire('./emailService', {
    nodemailer: nodemailerStub,
    '../config/database': db,
  });

  return { service, sent };
}

test('sendWelcomeEmail sends html and text and is idempotent per recipient', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  const { service, sent } = buildService();

  await service.sendWelcomeEmail({ to: 'a@test.com', name: 'Alice', walletPublicKey: 'GPK' });
  await service.sendWelcomeEmail({ to: 'a@test.com', name: 'Alice', walletPublicKey: 'GPK' });

  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Welcome/);
  assert.ok(sent[0].html.includes('Alice'));
  assert.ok(sent[0].text.includes('Alice'));
  delete process.env.SMTP_HOST;
});

test('sendCampaignFundedCreatorEmail and contributor email both render html+text', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  const { service, sent } = buildService();

  await service.sendCampaignFundedCreatorEmail({
    to: 'creator@test.com',
    campaignId: 'camp-1',
    creatorName: 'Creator',
    campaignTitle: 'My Campaign',
    campaignUrl: 'https://app/campaigns/camp-1',
    targetAmount: '100',
    raisedAmount: '100',
  });
  await service.sendCampaignFundedContributorEmail({
    to: 'backer@test.com',
    campaignId: 'camp-1',
    contributorName: 'Backer',
    campaignTitle: 'My Campaign',
    campaignUrl: 'https://app/campaigns/camp-1',
  });

  assert.equal(sent.length, 2);
  assert.ok(sent[0].html.includes('My Campaign'));
  assert.ok(sent[1].html.includes('My Campaign'));
});

test('sendCampaignUpdatePostedEmail skips recipients who unsubscribed from campaign_update', async () => {
  process.env.SMTP_HOST = 'smtp.test';
  const { service, sent } = buildService({
    queryImpl: (text, params) => {
      if (text.includes('FROM email_unsubscribes')) {
        return { rows: params[0] === 'unsubscribed@test.com' ? [{ x: 1 }] : [] };
      }
      return undefined;
    },
  });

  await service.sendCampaignUpdatePostedEmail({
    to: 'unsubscribed@test.com',
    updateId: 'upd-1',
    name: 'Subscriber',
    campaignTitle: 'My Campaign',
    campaignUrl: 'https://app/campaigns/camp-1',
    updateTitle: 'Big news',
    updateBody: 'Things happened.',
  });
  await service.sendCampaignUpdatePostedEmail({
    to: 'subscribed@test.com',
    updateId: 'upd-1',
    name: 'Subscriber',
    campaignTitle: 'My Campaign',
    campaignUrl: 'https://app/campaigns/camp-1',
    updateTitle: 'Big news',
    updateBody: 'Things happened.',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'subscribed@test.com');
  assert.ok(sent[0].html.includes('Unsubscribe'));
});
