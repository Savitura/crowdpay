const crypto = require('crypto');

function secret() {
  const s = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!s) {
    throw new Error('UNSUBSCRIBE_SECRET (or JWT_SECRET fallback) is not configured');
  }
  return s;
}

function sign(email, category, campaignId) {
  const base = `${email.toLowerCase()}:${category}`;
  const payload = campaignId ? `${base}:${campaignId}` : base;
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function buildUnsubscribeUrl({ email, category, campaignId }) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const params = new URLSearchParams({ email, category, sig: sign(email, category, campaignId) });
  if (campaignId) params.set('campaign_id', String(campaignId));
  return `${base}/settings/notifications?${params.toString()}`;
}

function verifyUnsubscribeToken({ email, category, sig, campaign_id: campaignId }) {
  if (!email || !category || !sig) return false;
  const expected = sign(email, category, campaignId || undefined);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { buildUnsubscribeUrl, verifyUnsubscribeToken };
