'use strict';

const db = require('../config/database');
const crypto = require('crypto');

const SIGNING_ALGO = 'sha256';
const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

function signingSecret() {
  return process.env.JWT_SECRET || 'campaign-report-signing-secret';
}

function verifySignedToken(token, campaignId) {
  const sep = token.lastIndexOf('.');
  if (sep < 0) return false;
  const payload = token.slice(0, sep);
  const sig = token.slice(sep + 1);

  const expected = crypto
    .createHmac(SIGNING_ALGO, signingSecret())
    .update(payload)
    .digest('hex');

  const supplied = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (supplied.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(supplied, expectedBuf)) return false;

  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (decoded.cid !== campaignId) return false;
  if (typeof decoded.exp !== 'number' || Date.now() > decoded.exp) return false;

  return true;
}

function generateSignedUrl(campaignId, baseUrl) {
  const payload = JSON.stringify({
    cid: campaignId,
    exp: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
  });
  const encoded = Buffer.from(payload).toString('base64url');
  const sig = crypto
    .createHmac(SIGNING_ALGO, signingSecret())
    .update(encoded)
    .digest('hex');
  return `${baseUrl}/api/campaigns/${campaignId}/report/share/${encoded}.${sig}`;
}

function truncPubKey(key) {
  if (!key || key.length <= 16) return key || 'N/A';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

async function assembleReport(campaignId) {
  const [
    campaignResult,
    totalsResult,
    assetBreakdownResult,
    milestonesResult,
    topContributorsResult,
    dailySeriesResult,
    statusEventsResult,
  ] = await Promise.all([
    db.query(
      `SELECT id, title, description, target_amount, raised_amount, asset_type,
              status, deadline, category, created_at, share_count
       FROM campaigns WHERE id = $1`,
      [campaignId]
    ),
    db.query(
      `SELECT
         COUNT(*)::int AS total_contributions,
         COUNT(DISTINCT sender_public_key)::int AS unique_contributors,
         COALESCE(SUM(amount), 0) AS total_received,
         COALESCE(AVG(amount), 0) AS average_contribution,
         COALESCE(MAX(amount), 0) AS largest_contribution,
         COALESCE(SUM(platform_fee_amount), 0) AS total_platform_fees
       FROM contributions
       WHERE campaign_id = $1`,
      [campaignId]
    ),
    db.query(
      `SELECT COALESCE(source_asset, asset) AS asset,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount), 0) AS total
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY asset
       ORDER BY total DESC`,
      [campaignId]
    ),
    db.query(
      `SELECT title, description, release_percentage, sort_order, status,
              completed_at, approved_at, released_at
       FROM milestones
       WHERE campaign_id = $1
       ORDER BY sort_order ASC`,
      [campaignId]
    ),
    db.query(
      `SELECT ctr.sender_public_key,
              ctr.display_name,
              u.name AS contributor_name,
              COUNT(*)::int AS contribution_count,
              COALESCE(SUM(ctr.amount), 0) AS total_amount,
              MIN(ctr.created_at) AS first_contribution_at
       FROM contributions ctr
       LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
       WHERE ctr.campaign_id = $1
       GROUP BY ctr.sender_public_key, ctr.display_name, u.name
       ORDER BY total_amount DESC
       LIMIT 10`,
      [campaignId]
    ),
    db.query(
      `SELECT
         DATE(created_at)::text AS day,
         COUNT(*)::int AS count,
         COALESCE(SUM(amount), 0) AS amount
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [campaignId]
    ),
    db.query(
      `SELECT old_status, new_status, created_at
       FROM campaign_status_events
       WHERE campaign_id = $1
       ORDER BY created_at ASC`,
      [campaignId]
    ),
  ]);

  if (!campaignResult.rows.length) {
    return null;
  }

  const c = campaignResult.rows[0];
  const t = totalsResult.rows[0];
  const target = Number(c.target_amount) || 0;
  const raised = Number(t.total_received) || 0;
  const goalPct = target > 0 ? Math.min(100, (raised / target) * 100) : 0;

  const milestones = milestonesResult.rows.map((m) => {
    const threshold = (Number(m.release_percentage) / 100) * target;
    const progressPct = target > 0 ? Math.min(100, (raised / threshold) * 100) : 0;
    return {
      title: m.title,
      description: m.description,
      release_percentage: Number(m.release_percentage),
      status: m.status,
      progress_pct: Math.round(progressPct * 10) / 10,
      completed_at: m.completed_at,
      approved_at: m.approved_at,
      released_at: m.released_at,
    };
  });

  const topContributors = topContributorsResult.rows.map((r) => ({
    display_name: r.display_name || r.contributor_name || 'Anonymous',
    truncated_key: truncPubKey(r.sender_public_key),
    contribution_count: r.contribution_count,
    total_amount: Number(r.total_amount),
    first_contribution_at: r.first_contribution_at,
  }));

  const dailySeries = dailySeriesResult.rows.map((r) => ({
    day: r.day,
    count: r.count,
    amount: Number(r.amount),
  }));

  const timeline = statusEventsResult.rows.map((e) => ({
    from: e.old_status,
    to: e.new_status,
    at: e.created_at,
  }));

  const platformFees = Number(t.total_platform_fees) || 0;
  const netReceived = raised - platformFees;

  return {
    campaign: {
      id: c.id,
      title: c.title,
      description: c.description,
      target_amount: target,
      raised_amount: raised,
      asset_type: c.asset_type,
      status: c.status,
      deadline: c.deadline,
      category: c.category,
      created_at: c.created_at,
      share_count: c.share_count,
    },
    financials: {
      goal_pct: Math.round(goalPct * 10) / 10,
      total_received: raised,
      target_amount: target,
      total_platform_fees: platformFees,
      net_received: netReceived,
      average_contribution: Number(t.average_contribution) || 0,
      largest_contribution: Number(t.largest_contribution) || 0,
    },
    engagement: {
      total_contributions: t.total_contributions,
      unique_contributors: t.unique_contributors,
      asset_breakdown: assetBreakdownResult.rows.map((a) => ({
        asset: a.asset,
        count: a.count,
        total: Number(a.total),
      })),
    },
    top_contributors: topContributors,
    milestones,
    daily_series: dailySeries,
    timeline,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  assembleReport,
  generateSignedUrl,
  verifySignedToken,
  SIGNED_URL_TTL_SECONDS,
};
