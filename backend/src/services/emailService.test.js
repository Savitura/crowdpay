const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { buildUnsubscribeUrl, verifyUnsubscribeToken } = require('../utils/unsubscribeToken');

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
  const { service, sent } = buildService({
    queryImpl: (text, params) => {
      if (text.includes('notification_preferences')) {
        return { rows: [{ marketing: true }] };
      }
      return undefined;
    }
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
  
  const isInvalid = verifyUnsubscribeToken({ email: 'test@test.com', category: 'refund', sig: 'fake' });
  assert.equal(isInvalid, false);
});
