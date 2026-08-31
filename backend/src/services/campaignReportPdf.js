'use strict';

const PDFDocument = require('pdfkit');

const BRAND_COLOR = '#0f1f3d';
const ACCENT_COLOR = '#7c3aed';
const MUTED_COLOR = '#666666';
const TEXT_COLOR = '#1a1a1a';
const LABEL_COLOR = '#555555';
const PAGE_MARGIN = 50;

const STATUS_LABELS = {
  pending: 'Pending',
  pending_review: 'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
  released: 'Released',
};

function formatValue(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return String(value);
}

function formatCurrency(amount, asset) {
  return `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 7 })} ${asset || ''}`;
}

function drawSectionHeader(doc, title) {
  doc.moveDown(1);
  doc.fontSize(14).fillColor(BRAND_COLOR).text(title, { underline: true });
  doc.moveDown(0.5);
}

function drawLabelValue(doc, label, value) {
  doc.fontSize(10).fillColor(LABEL_COLOR).text(`${label}: `, { continued: true, bold: true });
  doc.fillColor(TEXT_COLOR).text(String(value));
  doc.moveDown(0.2);
}

function drawProgressBar(doc, pct, width) {
  const barY = doc.y;
  const barHeight = 12;
  const filled = Math.min(100, Math.max(0, pct));

  doc.rect(doc.x, barY, width, barHeight).fill('#e5e7eb');
  if (filled > 0) {
    doc.rect(doc.x, barY, (width * filled) / 100, barHeight).fill(ACCENT_COLOR);
  }
  doc.fillColor(TEXT_COLOR);
  doc.fontSize(9).text(`${pct.toFixed(1)}%`, doc.x + width + 6, barY + 1);
  doc.y = barY + barHeight + 4;
}

function renderReportContent(doc, report) {
  const c = report.campaign;
  const asset = c.asset_type;
  const f = report.financials;
  const e = report.engagement;

  // ── Header ──
  doc.fontSize(22).fillColor(BRAND_COLOR).text('Campaign Analytics Report', { align: 'left' });
  doc.fontSize(10).fillColor(MUTED_COLOR).text(`Generated ${report.generated_at}`);
  doc.moveDown(1.5);

  // ── Campaign Summary ──
  doc.fontSize(14).fillColor(BRAND_COLOR).text('Campaign Summary', { underline: true });
  doc.moveDown(0.5);
  drawLabelValue(doc, 'Title', c.title);
  drawLabelValue(doc, 'Status', c.status);
  drawLabelValue(doc, 'Category', c.category || 'Uncategorized');
  drawLabelValue(doc, 'Created', formatValue(c.created_at));
  drawLabelValue(doc, 'Deadline', formatValue(c.deadline));
  drawLabelValue(doc, 'Description', c.description || 'No description provided');
  doc.moveDown(0.5);

  // ── Financial Overview ──
  drawSectionHeader(doc, 'Financial Overview');
  drawLabelValue(doc, 'Funds Raised', formatCurrency(f.raised_amount, asset));
  drawLabelValue(doc, 'Goal', formatCurrency(f.target_amount, asset));
  drawLabelValue(doc, 'Goal Progress', `${f.goal_pct}%`);
  drawProgressBar(doc, f.goal_pct, 250);
  drawLabelValue(doc, 'Net Received (after fees)', formatCurrency(f.net_received, asset));
  drawLabelValue(doc, 'Platform Fees', formatCurrency(f.total_platform_fees, asset));
  drawLabelValue(doc, 'Average Contribution', formatCurrency(f.average_contribution, asset));
  drawLabelValue(doc, 'Largest Contribution', formatCurrency(f.largest_contribution, asset));

  // ── Contributor Breakdown ──
  drawSectionHeader(doc, 'Contributor Breakdown');
  drawLabelValue(doc, 'Total Contributions', e.total_contributions);
  drawLabelValue(doc, 'Unique Contributors', e.unique_contributors);
  if (e.asset_breakdown && e.asset_breakdown.length) {
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor(LABEL_COLOR).text('Asset Breakdown:');
    doc.moveDown(0.2);
    for (const a of e.asset_breakdown) {
      doc.fontSize(9).fillColor(TEXT_COLOR).text(`  ${a.asset}: ${a.count} contributions — ${formatCurrency(a.total, a.asset)}`);
    }
  }

  // ── Top Contributors ──
  drawSectionHeader(doc, 'Top Contributors');
  if (!report.top_contributors || report.top_contributors.length === 0) {
    doc.fontSize(10).fillColor(MUTED_COLOR).text('No contributors yet.');
  } else {
    doc.fontSize(9).fillColor(BRAND_COLOR).text('Rank  Contributor                  Wallet               Count   Total');
    doc.moveDown(0.2);
    for (let idx = 0; idx < report.top_contributors.length; idx++) {
      const tc = report.top_contributors[idx];
      doc.fontSize(9).fillColor(TEXT_COLOR).text(
        `${String(idx + 1).padEnd(5)} ${(tc.display_name || '').padEnd(28)} ${(tc.truncated_key || '').padEnd(20)} ${String(tc.contribution_count).padEnd(7)} ${formatCurrency(tc.total_amount, asset)}`
      );
      doc.moveDown(0.3);
    }
  }

  // ── Milestone Status ──
  drawSectionHeader(doc, 'Milestone Status');
  if (!report.milestones || report.milestones.length === 0) {
    doc.fontSize(10).fillColor(MUTED_COLOR).text('No milestones defined.');
  } else {
    for (const m of report.milestones) {
      doc.fontSize(10).fillColor(BRAND_COLOR).text(m.title, { bold: true });
      doc.fontSize(9).fillColor(LABEL_COLOR).text(
        `Release: ${m.release_percentage}%  |  Status: ${STATUS_LABELS[m.status] || m.status}  |  Progress: ${m.progress_pct}%`
      );
      if (m.description) {
        doc.fontSize(9).fillColor(MUTED_COLOR).text(m.description, { indent: 10 });
      }
      drawProgressBar(doc, m.progress_pct, 200);
      doc.moveDown(0.3);
    }
  }

  // ── Funding Timeline ──
  drawSectionHeader(doc, 'Funding Timeline');
  if (!report.daily_series || report.daily_series.length === 0) {
    doc.fontSize(10).fillColor(MUTED_COLOR).text('No contribution activity recorded.');
  } else {
    doc.fontSize(9).fillColor(LABEL_COLOR).text('Daily contribution summary:');
    doc.moveDown(0.3);
    for (const d of report.daily_series) {
      doc.fontSize(9).fillColor(TEXT_COLOR).text(
        `  ${d.day}: ${d.count} contribution${d.count === 1 ? '' : 's'} — ${formatCurrency(d.amount, asset)}`
      );
    }
  }

  // ── Status Change Timeline ──
  if (report.timeline && report.timeline.length > 0) {
    drawSectionHeader(doc, 'Status Change Timeline');
    for (const t of report.timeline) {
      doc.fontSize(9).fillColor(TEXT_COLOR).text(
        `  ${formatValue(t.at)}: ${t.from || '(none)'} → ${t.to}`
      );
    }
  }

  // ── Footer ──
  doc.moveDown(3);
  doc.fontSize(8).fillColor(MUTED_COLOR).text(
    'CrowdPay — Blockchain-powered crowdfunding. All contribution data is recorded on the Stellar network.',
    { align: 'center' }
  );
}

/**
 * Stream the rendered report directly to an HTTP response. The PDF bytes are
 * piped chunk-by-chunk as they are produced, so the whole document is never
 * buffered in memory.
 */
function streamCampaignReportPdf(report, res) {
  const doc = new PDFDocument({ margin: PAGE_MARGIN });
  doc.pipe(res);
  renderReportContent(doc, report);
  doc.end();
}

/**
 * Render the report to an in-memory Buffer. Used by tests and any flows that
 * require a fully materialised document (e.g. caching to object storage).
 */
function generateCampaignReportPdfBuffer(report) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: PAGE_MARGIN });

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    renderReportContent(doc, report);
    doc.end();
  });
}

function reportFilename(campaignId, campaignTitle) {
  const safeTitle = (campaignTitle || campaignId)
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  const safeId = String(campaignId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeTitle}-${safeId}-report.pdf`;
}

module.exports = {
  streamCampaignReportPdf,
  generateCampaignReportPdfBuffer,
  reportFilename,
};
