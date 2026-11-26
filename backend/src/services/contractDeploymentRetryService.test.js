'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

const PLATFORM_KEYPAIR = Keypair.random();
const CREATOR_PUBLIC_KEY = Keypair.random().publicKey();

function buildService({
  lockAcquired = true,
  campaigns = [],
  deployImpl = async () => ({
    escrowContractId: 'CESCROW123',
    milestonesContractId: 'CMILESTONES123',
  }),
  queryError = null,
} = {}) {
  const queries = [];
  const sentryMessages = [];
  const logEvents = { info: [], warn: [], error: [] };
  let released = false;

  const client = {
    query: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: lockAcquired }] };
      }
      if (text.includes('FROM campaigns c')) {
        if (queryError) throw queryError;
        return { rows: campaigns };
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };

  const service = proxyquire('./contractDeploymentRetryService', {
    '../config/database': {
      connect: async () => client,
    },
    '../config/logger': {
      info: (msg, meta) => logEvents.info.push({ msg, meta }),
      warn: (msg, meta) => logEvents.warn.push({ msg, meta }),
      error: (msg, meta) => logEvents.error.push({ msg, meta }),
    },
    '@sentry/node': {
      withScope: fn =>
        fn({
          setLevel: () => {},
          setTag: () => {},
          setContext: () => {},
        }),
      captureMessage: msg => sentryMessages.push(msg),
    },
    './sorobanService': {
      deployCampaignContracts: deployImpl,
    },
  });

  return {
    service,
    queries,
    sentryMessages,
    logEvents,
    isReleased: () => released,
  };
}

test('skips retry when Postgres advisory lock is held by another instance', async () => {
  const { service, queries, isReleased } = buildService({ lockAcquired: false });

  const result = await service.retryFailedContractDeployments();

  assert.deepEqual(result, { retried: 0, succeeded: 0, failed: 0, skipped: true });
  assert.equal(
    queries.some(q => q.text.includes('pg_advisory_unlock')),
    false
  );
  assert.equal(isReleased(), true);
});

test('returns zero counts and unlocks when no failed campaigns meet retry backoff', async () => {
  const { service, queries, isReleased } = buildService({ campaigns: [] });

  const result = await service.retryFailedContractDeployments();

  assert.deepEqual(result, { retried: 0, succeeded: 0, failed: 0, skipped: false });
  const selectQuery = queries.find(q => q.text.includes('FROM campaigns c'));
  assert.ok(selectQuery.text.includes("INTERVAL '5 minutes'"));
  assert.deepEqual(selectQuery.params, [10]);
  assert.equal(
    queries.some(q => q.text.includes('pg_advisory_unlock')),
    true
  );
  assert.equal(isReleased(), true);
});

test('skips deployment when PLATFORM_SECRET_KEY is not configured', async () => {
  const prevSecret = process.env.PLATFORM_SECRET_KEY;
  delete process.env.PLATFORM_SECRET_KEY;

  try {
    const { service, logEvents, isReleased } = buildService({
      campaigns: [
        {
          id: 'camp-1',
          title: 'Clean Water',
          target_amount: '100',
          creator_public_key: CREATOR_PUBLIC_KEY,
        },
      ],
    });

    const result = await service.retryFailedContractDeployments();

    assert.deepEqual(result, { retried: 0, succeeded: 0, failed: 0, skipped: false });
    assert.equal(logEvents.warn.length, 1);
    assert.equal(isReleased(), true);
  } finally {
    if (prevSecret !== undefined) process.env.PLATFORM_SECRET_KEY = prevSecret;
  }
});

test('retries failed deployments and updates succeeded and failed campaigns', async () => {
  const prevSecret = process.env.PLATFORM_SECRET_KEY;
  const prevContract = process.env.USDC_CONTRACT_ADDRESS;
  process.env.PLATFORM_SECRET_KEY = PLATFORM_KEYPAIR.secret();
  process.env.USDC_CONTRACT_ADDRESS = 'CUSDC123';

  const deployCalls = [];
  try {
    const { service, queries, sentryMessages, isReleased } = buildService({
      campaigns: [
        {
          id: 'camp-ok',
          title: 'Solar Microgrid',
          target_amount: '250.5',
          deadline: '2026-12-31T00:00:00.000Z',
          platform_fee_bps: 250,
          creator_public_key: CREATOR_PUBLIC_KEY,
          contract_deployment_error: 'previous timeout',
        },
        {
          id: 'camp-fail',
          title: 'School Library',
          target_amount: '100',
          deadline: null,
          platform_fee_bps: 0,
          creator_public_key: CREATOR_PUBLIC_KEY,
          contract_deployment_error: 'rpc error',
        },
      ],
      deployImpl: async args => {
        deployCalls.push(args);
        if (args.campaignId.startsWith('School Library')) {
          throw new Error('soroban simulation failed');
        }
        return {
          escrowContractId: 'CESCROW_NEW',
          milestonesContractId: 'CMILESTONES_NEW',
        };
      },
    });

    const result = await service.retryFailedContractDeployments();

    assert.deepEqual(result, { retried: 2, succeeded: 1, failed: 1, skipped: false });
    assert.equal(deployCalls.length, 2);
    assert.equal(deployCalls[0].targetAmount, 2_505_000_000n);
    assert.equal(deployCalls[0].platformPublicKey, PLATFORM_KEYPAIR.publicKey());
    assert.equal(deployCalls[0].assetContractAddress, 'CUSDC123');
    assert.equal(deployCalls[0].platformFeeBps, 250);

    const deployedUpdate = queries.find(q =>
      q.text.includes("contract_deployment_status = 'deployed'")
    );
    assert.deepEqual(deployedUpdate.params, ['CESCROW_NEW', 'CMILESTONES_NEW', 'camp-ok']);

    const failedUpdate = queries.find(
      q =>
        q.text.includes('UPDATE campaigns') &&
        q.text.includes("contract_deployment_status = 'failed'")
    );
    assert.deepEqual(failedUpdate.params, ['soroban simulation failed', 'camp-fail']);

    assert.equal(sentryMessages.length, 1);
    assert.match(sentryMessages[0], /camp-fail.*soroban simulation failed/);
    assert.equal(
      queries.some(q => q.text.includes('pg_advisory_unlock')),
      true
    );
    assert.equal(isReleased(), true);
  } finally {
    if (prevSecret === undefined) delete process.env.PLATFORM_SECRET_KEY;
    else process.env.PLATFORM_SECRET_KEY = prevSecret;
    if (prevContract === undefined) delete process.env.USDC_CONTRACT_ADDRESS;
    else process.env.USDC_CONTRACT_ADDRESS = prevContract;
  }
});

test('always unlocks advisory lock and releases client when query throws', async () => {
  const { service, queries, isReleased } = buildService({
    queryError: new Error('db connection lost'),
  });

  await assert.rejects(() => service.retryFailedContractDeployments(), /db connection lost/);
  assert.equal(
    queries.some(q => q.text.includes('pg_advisory_unlock')),
    true
  );
  assert.equal(isReleased(), true);
});
