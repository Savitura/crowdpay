const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const CAMPAIGN_ID = 'campaign-1';
const CREATOR_PUBLIC_KEY = 'GCREATOR';
const WALLET_PUBLIC_KEY = 'WCAMPAIGN';
const PLATFORM_PUBLIC_KEY = 'GPLATFORM';
const ESCROW_ID = 'ESCROW-1';
const MILESTONES_ID = 'MILESTONES-1';

const ENV_KEYS = [
  'PLATFORM_SECRET_KEY',
  'PLATFORM_FEE_BPS',
  'USDC_CONTRACT_ADDRESS',
  'USDC_ISSUER',
  'SOROBAN_ENABLED',
];

function setEnv(t, values) {
  const original = {};
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
  }
  for (const key of ENV_KEYS) {
    if (key in values) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  }
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

function buildService(overrides = {}) {
  const calls = {
    queries: [],
    walletCreations: [],
    deployments: [],
    watched: [],
    logged: [],
    stroops: [],
  };

  const campaign = {
    id: CAMPAIGN_ID,
    title: 'Clean Water',
    target_amount: '25000',
    asset_type: 'USDC',
    deadline: '2027-12-31T23:59:59Z',
    creator_id: 'creator-1',
    status: 'draft',
    ...(overrides.campaign || {}),
  };

  const creatorRows = overrides.creatorMissing ? [] : [{ wallet_public_key: CREATOR_PUBLIC_KEY }];

  const milestoneRows =
    overrides.milestones === undefined
      ? [
          {
            title: 'Phase 1',
            description: 'Drilling',
            release_percentage: '33.3333',
            sort_order: 1,
          },
          {
            title: 'Phase 2',
            description: 'Handover',
            release_percentage: '66.6667',
            sort_order: 2,
          },
        ]
      : overrides.milestones;

  const updatedRows = overrides.updateReturnsEmpty
    ? []
    : [
        {
          ...campaign,
          status: 'active',
          wallet_public_key: WALLET_PUBLIC_KEY,
          escrow_contract_id: ESCROW_ID,
          milestones_contract_id: MILESTONES_ID,
        },
      ];

  const service = proxyquire('./campaignPublishing', {
    '../config/database': {
      query: async (text, params) => {
        calls.queries.push({ text, params });
        if (text.includes('FROM campaigns WHERE id = $1')) {
          return { rows: overrides.noCampaign ? [] : [campaign] };
        }
        if (text.includes('FROM users WHERE id = $1')) {
          return { rows: creatorRows };
        }
        if (text.includes('FROM milestones WHERE campaign_id = $1')) {
          return { rows: milestoneRows };
        }
        if (text.includes('UPDATE campaigns')) {
          return { rows: updatedRows };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    },
    '../config/logger': {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: (...args) => calls.logged.push(args),
    },
    '@stellar/stellar-sdk': {
      Keypair: {
        fromSecret: () => ({ publicKey: () => PLATFORM_PUBLIC_KEY }),
      },
    },
    './stellarService': {
      createCampaignWallet: async publicKey => {
        calls.walletCreations.push(publicKey);
        return { publicKey: WALLET_PUBLIC_KEY };
      },
    },
    './sorobanService': {
      deployCampaignContracts: async payload => {
        calls.deployments.push(payload);
        return (
          overrides.deployment || {
            escrowContractId: ESCROW_ID,
            milestonesContractId: MILESTONES_ID,
          }
        );
      },
    },
    './ledgerMonitor': {
      watchCampaignWallet: (...args) => calls.watched.push(args),
    },
    '../utils/stroops': {
      toStroops: amount => {
        calls.stroops.push(amount);
        return 250000000000n;
      },
    },
  });

  return { service, calls, campaign };
}

function useDefaultEnv(t) {
  setEnv(t, {
    PLATFORM_SECRET_KEY: 'SECRET',
    PLATFORM_FEE_BPS: '250',
    USDC_CONTRACT_ADDRESS: 'CCONTRACT',
    SOROBAN_ENABLED: 'false',
  });
}

test('publishDraftCampaign deploys contracts, activates the draft and returns the updated row', async t => {
  useDefaultEnv(t);
  const { service, calls } = buildService();

  const result = await service.publishDraftCampaign(CAMPAIGN_ID);

  assert.equal(result.status, 'active');
  assert.equal(result.wallet_public_key, WALLET_PUBLIC_KEY);
  assert.deepEqual(calls.walletCreations, [CREATOR_PUBLIC_KEY]);
  assert.deepEqual(calls.stroops, ['25000']);
  assert.equal(calls.deployments.length, 1);

  const deployment = calls.deployments[0];
  assert.equal(deployment.creatorPublicKey, CREATOR_PUBLIC_KEY);
  assert.equal(deployment.platformPublicKey, PLATFORM_PUBLIC_KEY);
  assert.equal(deployment.targetAmount, 250000000000n);
  assert.equal(deployment.platformFeeBps, 250);
  assert.equal(
    deployment.deadlineUnix,
    Math.floor(new Date('2027-12-31T23:59:59Z').getTime() / 1000)
  );
  assert.equal(deployment.assetContractAddress, 'CCONTRACT');
  assert.match(deployment.campaignId, /^Clean Water\d+$/);
  assert.deepEqual(deployment.milestones, [
    {
      title: 'Phase 1',
      description: 'Drilling',
      release_percentage: '33.3333',
      release_percentage_units: 333333,
      sort_order: 1,
    },
    {
      title: 'Phase 2',
      description: 'Handover',
      release_percentage: '66.6667',
      release_percentage_units: 666667,
      sort_order: 2,
    },
  ]);

  const update = calls.queries.find(q => q.text.includes('UPDATE campaigns'));
  assert.ok(update);
  assert.match(update.text, /status = 'active'/);
  assert.match(update.text, /scheduled_publish_at = NULL/);
  assert.deepEqual(update.params, [WALLET_PUBLIC_KEY, ESCROW_ID, MILESTONES_ID, 250, CAMPAIGN_ID]);
  assert.deepEqual(calls.watched, [[CAMPAIGN_ID, WALLET_PUBLIC_KEY]]);
});

test('publishDraftCampaign refuses missing campaigns and campaigns that are not drafts', async t => {
  useDefaultEnv(t);
  for (const overrides of [{ noCampaign: true }, { campaign: { status: 'active' } }]) {
    const { service, calls } = buildService(overrides);

    await assert.rejects(
      () => service.publishDraftCampaign(CAMPAIGN_ID),
      err => {
        assert.ok(err instanceof service.CampaignNotPublishableError);
        assert.match(err.message, /not found or is not a draft/);
        return true;
      }
    );

    assert.equal(calls.walletCreations.length, 0);
    assert.equal(calls.deployments.length, 0);
    assert.ok(!calls.queries.some(q => q.text.includes('UPDATE campaigns')));
  }
});

test('publishDraftCampaign refuses a draft whose creator has no wallet', async t => {
  useDefaultEnv(t);
  const { service, calls } = buildService({ creatorMissing: true });

  await assert.rejects(
    () => service.publishDraftCampaign(CAMPAIGN_ID),
    err => {
      assert.ok(err instanceof service.CampaignNotPublishableError);
      assert.match(err.message, /creator has no wallet configured/);
      return true;
    }
  );

  assert.equal(calls.walletCreations.length, 0);
  assert.equal(calls.deployments.length, 0);
  assert.ok(!calls.queries.some(q => q.text.includes('UPDATE campaigns')));
});

test('publishDraftCampaign refuses activation when Soroban returns no contract IDs', async t => {
  setEnv(t, {
    PLATFORM_SECRET_KEY: 'SECRET',
    PLATFORM_FEE_BPS: '250',
    USDC_CONTRACT_ADDRESS: 'CCONTRACT',
    SOROBAN_ENABLED: 'true',
  });
  const { service, calls } = buildService({
    deployment: { escrowContractId: null, milestonesContractId: null },
  });

  await assert.rejects(
    () => service.publishDraftCampaign(CAMPAIGN_ID),
    err => {
      assert.ok(err instanceof service.CampaignNotPublishableError);
      assert.match(err.message, /no contract IDs/);
      return true;
    }
  );

  assert.equal(calls.deployments.length, 1);
  assert.ok(!calls.queries.some(q => q.text.includes('UPDATE campaigns')));
  assert.equal(calls.watched.length, 0);
});

test('publishDraftCampaign refuses a status race and logs the orphaned wallet', async t => {
  useDefaultEnv(t);
  const { service, calls } = buildService({ updateReturnsEmpty: true });

  await assert.rejects(
    () => service.publishDraftCampaign(CAMPAIGN_ID),
    err => {
      assert.ok(err instanceof service.CampaignNotPublishableError);
      assert.match(err.message, /no longer a draft/);
      return true;
    }
  );

  assert.ok(
    calls.logged.some(
      args =>
        String(args[0]).includes('Orphaned wallet') &&
        args[1].publicKey === WALLET_PUBLIC_KEY &&
        args[1].campaignId === CAMPAIGN_ID
    )
  );
  assert.equal(calls.watched.length, 0);
});

test('publishDraftCampaign defaults fee, deadline and asset address when env is unset', async t => {
  setEnv(t, {
    PLATFORM_SECRET_KEY: 'SECRET',
    PLATFORM_FEE_BPS: undefined,
    USDC_CONTRACT_ADDRESS: undefined,
    USDC_ISSUER: 'GISSUER',
    SOROBAN_ENABLED: 'false',
  });
  const { service, calls } = buildService({ campaign: { deadline: null }, milestones: [] });

  await service.publishDraftCampaign(CAMPAIGN_ID);

  assert.equal(calls.deployments[0].platformFeeBps, 0);
  assert.equal(calls.deployments[0].deadlineUnix, 0);
  assert.equal(calls.deployments[0].assetContractAddress, 'GISSUER');
  assert.deepEqual(calls.deployments[0].milestones, []);
});
