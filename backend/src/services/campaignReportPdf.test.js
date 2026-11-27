const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const proxyquire = require('proxyquire').noCallThru();
const PDFDocument = require('pdfkit');

const { streamCampaignReportPdf, reportFilename } = require('./campaignReportPdf');

function sampleReport(overrides = {}) {
  return {
    generated_at: '2026-06-02T00:00:00.000Z',
    campaign: {
      title: 'Solar Garden',
      status: 'active',
      category: 'Energy',
      created_at: '2026-01-15T00:00:00.000Z',
      deadline: '2026-07-01T00:00:00.000Z',
      description: 'Community panels',
      asset_type: 'USDC',
      ...overrides.campaign,
    },
    financials: {
      raised_amount: 750,
      target_amount: 1000,
      goal_pct: 75,
      net_received: 700,
      total_platform_fees: 50,
      average_contribution: 75,
      largest_contribution: 200,
      ...overrides.financials,
    },
    engagement: {
      total_contributions: 10,
      unique_contributors: 8,
      asset_breakdown: [{ asset: 'USDC', count: 10, total: 750 }],
      ...overrides.engagement,
    },
    top_contributors: overrides.top_contributors ?? [
      {
        display_name: 'Ada',
        truncated_key: 'GADA...LOVE',
        contribution_count: 2,
        total_amount: 200,
      },
    ],
    milestones: overrides.milestones ?? [
      {
        title: 'Prototype',
        release_percentage: 40,
        status: 'released',
        progress_pct: 100,
        description: 'Shipped',
      },
    ],
    daily_series: overrides.daily_series ?? [{ day: '2026-06-01', count: 1, amount: 25 }],
    timeline:
      overrides.timeline === undefined
        ? [{ at: '2026-06-01T00:00:00.000Z', from: 'draft', to: 'active' }]
        : overrides.timeline,
  };
}

async function render(report) {
  const seen = [];
  class RecordingPDFDocument extends PDFDocument {
    text(value, ...rest) {
      if (typeof value === 'string') seen.push(value);
      return super.text(value, ...rest);
    }
  }
  const { generateCampaignReportPdfBuffer } = proxyquire('./campaignReportPdf', {
    pdfkit: RecordingPDFDocument,
  });
  const buffer = await generateCampaignReportPdfBuffer(report);
  return { buffer, seen };
}

describe('campaign report PDF', { concurrency: 1 }, () => {
  test('generateCampaignReportPdfBuffer returns a PDF that includes report sections', async () => {
    const { buffer, seen } = await render(sampleReport());
    const text = seen.join('\n');

    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buffer.length > 500);
    assert.ok(text.includes('Campaign Analytics Report'));
    assert.ok(text.includes('Solar Garden'));
    assert.ok(text.includes('Energy'));
    assert.ok(text.includes('Funds Raised'));
    assert.ok(text.includes('Ada'));
    assert.ok(text.includes('Prototype'));
    assert.ok(text.includes('Released'));
    assert.ok(text.includes('2026-06-01'));
    assert.ok(text.includes('draft'));
  });

  test('generateCampaignReportPdfBuffer describes missing contributors, milestones, and activity', async () => {
    const { buffer, seen } = await render(
      sampleReport({
        campaign: { category: null, description: '', deadline: null },
        engagement: { total_contributions: 0, unique_contributors: 0, asset_breakdown: [] },
        top_contributors: [],
        milestones: [],
        daily_series: [],
        timeline: [],
      })
    );
    const text = seen.join('\n');

    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(text.includes('Uncategorized'));
    assert.ok(text.includes('No description provided'));
    assert.ok(text.includes('N/A'));
    assert.ok(text.includes('No contributors yet.'));
    assert.ok(text.includes('No milestones defined.'));
    assert.ok(text.includes('No contribution activity recorded.'));
    assert.equal(text.includes('Status Change Timeline'), false);
  });

  test('generateCampaignReportPdfBuffer labels unknown milestone status and a single daily contribution', async () => {
    const { seen } = await render(
      sampleReport({
        milestones: [
          {
            title: 'Launch',
            release_percentage: 10,
            status: 'custom_state',
            progress_pct: 0,
          },
        ],
        daily_series: [{ day: '2026-06-02', count: 1, amount: 5 }],
        timeline: [{ at: null, from: null, to: 'funded' }],
      })
    );
    const text = seen.join('\n');

    assert.ok(text.includes('custom_state'));
    assert.ok(text.includes('1 contribution —'));
    assert.ok(text.includes('(none) → funded'));
  });

  test('streamCampaignReportPdf writes PDF bytes to the response stream', async () => {
    const res = new PassThrough();
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    const finished = new Promise(resolve => res.on('end', resolve));

    streamCampaignReportPdf(sampleReport(), res);
    await finished;

    const buffer = Buffer.concat(chunks);
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buffer.includes(Buffer.from('%%EOF')));
  });

  test('reportFilename sanitizes the title and id and falls back when the title is missing', () => {
    assert.equal(reportFilename('camp-1', 'Hello World!'), 'hello-world-camp-1-report.pdf');
    assert.equal(reportFilename('camp/1', null), 'camp1-camp_1-report.pdf');
    assert.equal(reportFilename('id', 'A'.repeat(80)), `${'a'.repeat(60)}-id-report.pdf`);
  });
});
