const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildService({ queryImpl }) {
  return proxyquire('./campaignReportService', {
    '../config/database': { query: queryImpl },
  });
}

const baseRows = {
  campaign: {
    id: 'campaign-1',
    title: 'Test Campaign',
    description: 'A test campaign',
    target_amount: '1000.0000000',
    raised_amount: '0.0000000',
    asset_type: 'USDC',
    status: 'active',
    deadline: '2026-12-31',
    category: 'technology',
    created_at: new Date('2026-01-01T00:00:00Z'),
    share_count: 0,
  },
  totals: {
    total_contributions: 0,
    unique_contributors: 0,
    total_received: '0.0000000',
    average_contribution: '0.0000000',
    largest_contribution: '0.0000000',
    total_platform_fees: '0.0000000',
  },
  asset: [],
  milestones: [],
  topContributors: [],
  daily: [],
  statusEvents: [],
};

function buildQueryImpl({ campaign, totals, asset, milestones, topContributors, daily, statusEvents }) {
  const c = campaign === undefined ? baseRows.campaign : campaign;
  const t = totals === undefined ? baseRows.totals : totals;
  return async (text) => {
    if (text.includes('FROM campaigns WHERE id = $1')) return { rows: c ? [c] : [] };
    if (text.includes('FROM contributions\n       WHERE campaign_id = $1') && !text.includes('GROUP BY')) {
      if (text.includes('platform_fee_amount')) return { rows: [t] };
    }
    if (text.includes('GROUP BY asset')) return { rows: asset || [] };
    if (text.includes('FROM milestones')) return { rows: milestones || [] };
    if (text.includes('GROUP BY ctr.sender_public_key')) return { rows: topContributors || [] };
    if (text.includes('GROUP BY DATE(created_at)')) return { rows: daily || [] };
    if (text.includes('FROM campaign_status_events')) return { rows: statusEvents || [] };
    if (text.includes('FROM contributions')) return { rows: [t] };
    return { rows: [] };
  };
}

test('assembleReport returns null for nonexistent campaign', async () => {
  const service = buildService({ queryImpl: buildQueryImpl({ campaign: null }) });
  const report = await service.assembleReport('missing');
  assert.equal(report, null);
});

test('assembleReport handles an empty campaign gracefully', async () => {
  const service = buildService({ queryImpl: buildQueryImpl({}) });
  const report = await service.assembleReport('campaign-1');

  assert.ok(report);
  assert.equal(report.campaign.id, 'campaign-1');
  assert.equal(report.campaign.title, 'Test Campaign');
  assert.equal(report.engagement.total_contributions, 0);
  assert.equal(report.engagement.unique_contributors, 0);
  assert.equal(report.top_contributors.length, 0);
  assert.equal(report.milestones.length, 0);
  assert.equal(report.daily_series.length, 0);
  assert.equal(report.financials.goal_pct, 0);
  assert.equal(report.financials.total_received, 0);
});

test('assembleReport computes financials, milestones, and top contributors', async () => {
  const service = buildService({
    queryImpl: buildQueryImpl({
      campaign: { ...baseRows.campaign, target_amount: '1000.0000000' },
      totals: {
        total_contributions: 5,
        unique_contributors: 3,
        total_received: '750.0000000',
        average_contribution: '150.0000000',
        largest_contribution: '300.0000000',
        total_platform_fees: '50.0000000',
      },
      asset: [
        { asset: 'USDC', count: 4, total: '700.0000000' },
        { asset: 'XLM', count: 1, total: '50.0000000' },
      ],
      milestones: [
        {
          title: 'Milestone 1',
          description: 'First milestone',
          release_percentage: '50.0000',
          status: 'approved',
          completed_at: null,
          approved_at: new Date('2026-03-01T00:00:00Z'),
          released_at: null,
        },
      ],
      topContributors: [
        {
          sender_public_key: 'GABCDEFGHIJKLMNOPQRSTUV123456',
          display_name: 'Alice',
          contributor_name: 'Alice User',
          contribution_count: 3,
          total_amount: '500.0000000',
          first_contribution_at: new Date('2026-01-05T00:00:00Z'),
        },
      ],
      daily: [
        { day: '2026-01-01', count: 2, amount: '300.0000000' },
        { day: '2026-01-02', count: 3, amount: '450.0000000' },
      ],
      statusEvents: [
        { old_status: null, new_status: 'active', created_at: new Date('2026-01-01T00:00:00Z') },
      ],
    }),
  });

  const report = await service.assembleReport('campaign-1');

  assert.equal(report.financials.total_received, 750);
  assert.equal(report.financials.goal_pct, 75);
  assert.equal(report.financials.net_received, 700);
  assert.equal(report.financials.total_platform_fees, 50);
  assert.equal(report.engagement.total_contributions, 5);
  assert.equal(report.engagement.unique_contributors, 3);
  assert.equal(report.engagement.asset_breakdown.length, 2);
  assert.equal(report.top_contributors.length, 1);
  assert.equal(report.top_contributors[0].display_name, 'Alice');
  assert.equal(report.milestones[0].status, 'approved');
  assert.equal(report.milestones[0].progress_pct, 100);
  assert.equal(report.daily_series.length, 2);
  assert.equal(report.timeline.length, 1);
});

test('generateSignedUrl produces a token that verifySignedToken accepts', () => {
  process.env.JWT_SECRET = 'test-secret';
  const service = buildService({ queryImpl: buildQueryImpl({}) });
  const url = service.generateSignedUrl('campaign-1', 'https://crowdpay.io');
  const token = url.split('/report/share/')[1];
  assert.ok(token);
  assert.equal(url.startsWith('https://crowdpay.io/api/campaigns/campaign-1/report/share/'), true);
});

test('verifySignedToken rejects an expired token', () => {
  process.env.JWT_SECRET = 'test-secret';
  const service = buildService({ queryImpl: buildQueryImpl({}) });

  const payload = Buffer.from(
    JSON.stringify({ cid: 'campaign-1', exp: Date.now() - 1000 })
  ).toString('base64url');
  const crypto = require('crypto');
  const sig = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(payload)
    .digest('hex');

  assert.equal(service.verifySignedToken(`${payload}.${sig}`, 'campaign-1'), false);
});

test('verifySignedToken rejects a tampered signature', () => {
  process.env.JWT_SECRET = 'test-secret';
  const service = buildService({ queryImpl: buildQueryImpl({}) });

  const payload = Buffer.from(
    JSON.stringify({ cid: 'campaign-1', exp: Date.now() + 100000 })
  ).toString('base64url');

  assert.equal(service.verifySignedToken(`${payload}.deadbeef`, 'campaign-1'), false);
});

test('verifySignedToken rejects a token for a different campaign', () => {
  process.env.JWT_SECRET = 'test-secret';
  const service = buildService({ queryImpl: buildQueryImpl({}) });

  const payload = Buffer.from(
    JSON.stringify({ cid: 'campaign-other', exp: Date.now() + 100000 })
  ).toString('base64url');
  const crypto = require('crypto');
  const sig = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(payload)
    .digest('hex');

  assert.equal(service.verifySignedToken(`${payload}.${sig}`, 'campaign-1'), false);
});
