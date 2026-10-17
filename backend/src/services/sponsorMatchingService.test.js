const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService(queryImpl) {
  return proxyquire('./sponsorMatchingService', {
    '../config/database': {
      query: queryImpl,
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
    },
  });
}

test('createMatchingPledge validates matchRatio positive', async () => {
  const { createMatchingPledge } = buildService(async () => ({ rows: [] }));
  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: -1,
      pledgeAmount: '1000',
    }),
    /matchRatio must be positive/
  );
});

test('createMatchingPledge validates pledgeAmount positive', async () => {
  const { createMatchingPledge } = buildService(async () => ({ rows: [] }));
  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '0',
    }),
    /pledgeAmount must be positive/
  );
});

test('createMatchingPledge creates a pledge', async () => {
  const calls = [];
  const mockResult = {
    id: 'match-uuid-1',
    campaign_id: 'campaign-uuid-1',
    sponsor_user_id: 'sponsor-uuid-1',
    match_ratio: 1.0,
    pledge_amount: '1000',
    matched_amount: '0',
    status: 'active',
    created_at: new Date(),
  };

  const { createMatchingPledge } = buildService(async text => {
    calls.push(text);
    if (text.includes('SELECT id FROM campaign_matches')) {
      return { rows: [] };
    }
    return { rows: [mockResult] };
  });

  const result = await createMatchingPledge({
    campaignId: 'campaign-uuid-1',
    sponsorUserId: 'sponsor-uuid-1',
    matchRatio: 1.0,
    pledgeAmount: '1000',
  });

  assert.deepEqual(result, mockResult);
  assert.equal(calls.length, 2);
});

test('createMatchingPledge rejects an existing active pledge without inserting', async () => {
  const calls = [];
  const { createMatchingPledge } = buildService(async text => {
    calls.push(text);
    return { rows: [{ id: 'existing-match' }] };
  });

  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '1000',
    }),
    err => err.code === 'DUPLICATE_MATCHING_PLEDGE'
  );
  assert.equal(calls.length, 1);
});

test('createMatchingPledge maps a concurrent unique violation to the duplicate error', async () => {
  const { createMatchingPledge } = buildService(async text => {
    if (text.includes('SELECT id FROM campaign_matches')) {
      return { rows: [] };
    }
    const err = new Error('duplicate key value violates unique constraint');
    err.code = '23505';
    err.constraint = 'campaign_matches_active_sponsor_idx';
    throw err;
  });

  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '1000',
    }),
    err => err.code === 'DUPLICATE_MATCHING_PLEDGE'
  );
});

test('createMatchingPledge surfaces unrelated database errors', async () => {
  const { createMatchingPledge } = buildService(async text => {
    if (text.includes('SELECT id FROM campaign_matches')) {
      return { rows: [] };
    }
    const err = new Error('connection terminated');
    err.code = '08006';
    throw err;
  });

  await assert.rejects(
    createMatchingPledge({
      campaignId: 'campaign-uuid-1',
      sponsorUserId: 'sponsor-uuid-1',
      matchRatio: 1.0,
      pledgeAmount: '1000',
    }),
    /connection terminated/
  );
});

/**
 * Build a query stub for the matching flow that records every statement so the
 * tests can assert on ordering, locking and side effects.
 */
function matchingQueryImpl({ pools, claimReturns = rows => rows, onQuery = () => {} } = {}) {
  return async (text, params) => {
    onQuery(text, params);
    if (text.includes('FROM campaign_matches')) {
      return { rows: pools };
    }
    if (text.includes('UPDATE contributions')) {
      return { rows: claimReturns([{ id: params?.[2] }]) };
    }
    return { rows: [] };
  };
}

const ACTIVE_POOL = {
  id: 'match-uuid-1',
  match_ratio: 1.0,
  pledge_amount: 1000,
  matched_amount: 0,
};

test('processContributionMatch calculates correct match amount', async () => {
  const { processContributionMatch } = buildService(matchingQueryImpl({ pools: [ACTIVE_POOL] }));

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(matchedAmount, 100);
});

test('processContributionMatch applies 2:1 ratio', async () => {
  const { processContributionMatch } = buildService(
    matchingQueryImpl({ pools: [{ ...ACTIVE_POOL, match_ratio: 2.0, pledge_amount: 2000 }] })
  );

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(matchedAmount, 200);
});

test('processContributionMatch locks the pool row before spending it', async () => {
  const statements = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({ pools: [ACTIVE_POOL], onQuery: text => statements.push(text) })
  );

  await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  const poolSelect = statements.find(text => text.includes('FROM campaign_matches'));
  assert.match(poolSelect, /FOR UPDATE/);
  assert.match(poolSelect, /matched_amount < pledge_amount/);
});

test('processContributionMatch caps at pledge amount and marks exhausted', async () => {
  const updateCalls = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [{ ...ACTIVE_POOL, pledge_amount: 500, matched_amount: 0 }],
      onQuery: (text, params) => {
        if (text.includes('UPDATE campaign_matches')) updateCalls.push(params);
      },
    })
  );

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '600',
  });

  assert.equal(matchedAmount, 500);
  assert.ok(updateCalls.some(p => p.includes('exhausted')));
});

test('processContributionMatch credits the matched funds to the campaign ledger', async () => {
  const ledgerCalls = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [ACTIVE_POOL],
      onQuery: (text, params) => {
        if (text.includes('UPDATE campaigns')) ledgerCalls.push(params);
      },
    })
  );

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(matchedAmount, 100);
  assert.equal(ledgerCalls.length, 1);
  assert.deepEqual(ledgerCalls[0], [100, 'campaign-uuid-1']);
});

test('processContributionMatch is idempotent for an already matched contribution', async () => {
  const mutations = [];
  const { processContributionMatch } = buildService(
    matchingQueryImpl({
      pools: [ACTIVE_POOL],
      // The guarded UPDATE ... WHERE match_amount = 0 claims nothing.
      claimReturns: () => [],
      onQuery: text => {
        if (text.includes('UPDATE')) mutations.push(text);
      },
    })
  );

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(matchedAmount, 0);
  assert.ok(!mutations.some(text => text.includes('UPDATE campaign_matches')));
  assert.ok(!mutations.some(text => text.includes('UPDATE campaigns')));
});

test('processContributionMatch rounds amounts to 7 decimal places', async () => {
  const { processContributionMatch } = buildService(matchingQueryImpl({ pools: [ACTIVE_POOL] }));

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '0.12345678',
  });

  assert.equal(matchedAmount, 0.1234568);
});

test('processContributionMatch returns zero when pool exhausted', async () => {
  const { processContributionMatch } = buildService(async () => ({ rows: [] }));

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '50',
  });

  assert.equal(matchedAmount, 0);
});

test('processContributionMatch returns zero when no pool', async () => {
  const { processContributionMatch } = buildService(async () => ({ rows: [] }));

  const matchedAmount = await processContributionMatch({
    campaignId: 'campaign-uuid-1',
    contributionId: 'contrib-uuid-1',
    contributionAmount: '100',
  });

  assert.equal(matchedAmount, 0);
});

test('processContributionMatch validates a positive contribution amount', async () => {
  const { processContributionMatch } = buildService(async () => ({ rows: [] }));

  await assert.rejects(
    processContributionMatch({
      campaignId: 'campaign-uuid-1',
      contributionId: 'contrib-uuid-1',
      contributionAmount: '-5',
    }),
    /contributionAmount must be a positive number/
  );
});

test('getCampaignMatchProgress aggregates multiple sponsors', async () => {
  const { getCampaignMatchProgress } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        sponsor_user_id: 'sponsor-1',
        sponsor_name: 'Sponsor One',
        match_ratio: 1.0,
        pledge_amount: 1000,
        matched_amount: 300,
        status: 'active',
        created_at: new Date(),
        contribution_count: 3,
        total_contributed: 300,
      },
      {
        id: 'match-uuid-2',
        sponsor_user_id: 'sponsor-2',
        sponsor_name: 'Sponsor Two',
        match_ratio: 1.0,
        pledge_amount: 500,
        matched_amount: 100,
        status: 'active',
        created_at: new Date(),
        contribution_count: 1,
        total_contributed: 100,
      },
    ],
  }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.totalPledged, 1500);
  assert.equal(progress.totalMatched, 400);
  assert.equal(progress.remainingPoolAmount, 1100);
  assert.equal(progress.activePoolCount, 2);
  assert.equal(progress.percentageUsed, 26.67);
});

test('getCampaignMatchProgress never exposes sponsor user ids publicly', async () => {
  const { getCampaignMatchProgress } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        sponsor_user_id: 'sponsor-1',
        sponsor_name: 'Sponsor One',
        match_ratio: 1.0,
        pledge_amount: 1000,
        matched_amount: 300,
        status: 'active',
        created_at: new Date(),
        contribution_count: 3,
        total_contributed: 300,
      },
    ],
  }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.matches[0].sponsorId, undefined);
  assert.equal(progress.matches[0].sponsorUserId, undefined);
  assert.equal(progress.matches[0].sponsorName, 'Sponsor One');
});

test('getCampaignMatchProgress calculates zero percentage when no pledges', async () => {
  const { getCampaignMatchProgress } = buildService(async () => ({ rows: [] }));

  const progress = await getCampaignMatchProgress('campaign-uuid-1');

  assert.equal(progress.totalPledged, 0);
  assert.equal(progress.percentageUsed, 0);
});

test('completeMatchingPledge marks completed', async () => {
  const mockMatch = {
    id: 'match-uuid-1',
    campaign_id: 'campaign-uuid-1',
    sponsor_user_id: 'sponsor-uuid-1',
    pledge_amount: 1000,
    matched_amount: 600,
    status: 'completed',
  };

  const { completeMatchingPledge } = buildService(async () => ({ rows: [mockMatch] }));

  const result = await completeMatchingPledge('match-uuid-1');

  assert.deepEqual(result, mockMatch);
  assert.equal(result.status, 'completed');
});

test('completeMatchingPledge throws when not found', async () => {
  const { completeMatchingPledge } = buildService(async () => ({ rows: [] }));

  await assert.rejects(
    completeMatchingPledge('invalid-uuid'),
    /Match not found or already completed/
  );
});

test('getSponsorMatchingPledges returns sponsor pledges', async () => {
  const { getSponsorMatchingPledges } = buildService(async () => ({
    rows: [
      {
        id: 'match-uuid-1',
        campaign_id: 'campaign-1',
        campaign_title: 'Campaign A',
        campaign_status: 'active',
        sponsor_user_id: 'sponsor-uuid-1',
        sponsor_name: 'Sponsor',
        match_ratio: 1.0,
        pledge_amount: 1000,
        matched_amount: 300,
        status: 'active',
        contract_id: null,
        created_at: new Date(),
      },
    ],
  }));

  const pledges = await getSponsorMatchingPledges('sponsor-uuid-1');

  assert.equal(pledges.length, 1);
  assert.equal(pledges[0].pledgeAmount, 1000);
  assert.equal(pledges[0].remainingAmount, 700);
});
