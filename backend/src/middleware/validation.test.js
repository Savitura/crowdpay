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

test('createCampaign validation rejects negative max_per_user', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Valid Title',
    target_amount: '10',
    asset_type: 'USDC',
    max_per_user: '-5',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'max_per_user'));
});

test('createCampaign validation rejects max_per_user less than or equal to min_contribution', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Valid Title',
    target_amount: '100',
    asset_type: 'USDC',
    min_contribution: '10',
    max_per_user: '10',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'max_per_user' && e.msg === 'Per-contributor cap must be greater than minimum contribution'));
});

test('createCampaign validation passes with valid limit parameters', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Valid Title',
    target_amount: '100',
    asset_type: 'USDC',
    min_contribution: '10',
    max_contribution: '50',
    max_per_user: '80',
  });
  assert.equal(result.ok, true);
});


// Milestone percentage total validation tests
test('createCampaign validation rejects milestone percentages exceeding 100%', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Test Campaign',
    target_amount: '100',
    asset_type: 'USDC',
    milestones: [
      { title: 'Milestone 1', release_percentage: 80 },
      { title: 'Milestone 2', release_percentage: 80 }
    ]
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.msg === 'Milestone percentages must not exceed 100%'));
});

test('createCampaign validation accepts milestone percentages totalling exactly 100%', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Test Campaign',
    target_amount: '100',
    asset_type: 'USDC',
    milestones: [
      { title: 'Milestone 1', release_percentage: 40 },
      { title: 'Milestone 2', release_percentage: 60 }
    ]
  });
  assert.equal(result.ok, true);
});

test('createCampaign validation accepts milestone percentages totalling less than 100%', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Test Campaign',
    target_amount: '100',
    asset_type: 'USDC',
    milestones: [
      { title: 'Milestone 1', release_percentage: 40 },
      { title: 'Milestone 2', release_percentage: 30 }
    ]
  });
  assert.equal(result.ok, true);
});

test('createCampaign validation accepts single milestone with 100%', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Test Campaign',
    target_amount: '100',
    asset_type: 'USDC',
    milestones: [
      { title: 'Milestone 1', release_percentage: 100 }
    ]
  });
  assert.equal(result.ok, true);
});

test('createCampaign validation accepts four milestones with 25% each', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Test Campaign',
    target_amount: '100',
    asset_type: 'USDC',
    milestones: [
      { title: 'Milestone 1', release_percentage: 25 },
      { title: 'Milestone 2', release_percentage: 25 },
      { title: 'Milestone 3', release_percentage: 25 },
      { title: 'Milestone 4', release_percentage: 25 }
    ]
  });
  assert.equal(result.ok, true);
});

test('createCampaign validation rejects milestone percentages with floating point exceeding 100%', async () => {
  const result = await runValidation(createCampaignValidation, {
    title: 'Test Campaign',
    target_amount: '100',
    asset_type: 'USDC',
    milestones: [
      { title: 'Milestone 1', release_percentage: 50.1 },
      { title: 'Milestone 2', release_percentage: 50.1 }
    ]
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.msg === 'Milestone percentages must not exceed 100%'));
});