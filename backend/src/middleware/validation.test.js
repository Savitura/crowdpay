process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validationResult } = require('express-validator');
const {
  registerValidation,
  createCampaignValidation,
  contributionValidation,
  withdrawalValidation,
} = require('../middleware/validation');

async function runValidation(validations, body = {}, query = {}) {
  const req = { body, query };
  for (const fn of validations) {
    await fn(req, {}, () => {});
  }
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return { ok: false, errors: result.array() };
  }
  return { ok: true };
}

test('register validation rejects invalid email and short password', async () => {
  const result = await runValidation(registerValidation, {
    email: 'not-an-email',
    password: 'short',
    name: '',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
});

test('createCampaign validation rejects title longer than 100 characters', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'x'.repeat(101),
    target_amount: '10',
    asset_type: 'USDC',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'title'));
});

test('contribution validation rejects non-UUID campaign_id', async () => {
  const result = await runValidation(contributionValidation, {
    campaign_id: 'not-a-uuid',
    amount: '5',
    send_asset: 'XLM',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'campaign_id'));
});

test('withdrawal validation rejects invalid Stellar destination key', async () => {
  const result = await runValidation(withdrawalValidation, {
    campaign_id: '11111111-1111-1111-1111-111111111111',
    amount: '10',
    destination_key: 'invalid-key',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'destination_key'));
});

test('register validation passes for valid payload', async () => {
  const result = await runValidation(registerValidation, {
    email: 'user@example.com',
    password: 'Password1',
    name: 'Test User',
  });
  assert.equal(result.ok, true);
});
