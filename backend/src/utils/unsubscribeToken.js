const crypto = require("crypto");

function secret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || "dev-unsubscribe-secret";
}

function sign(email, category, campaignId) {
  const base = `${email.toLowerCase()}:${category}`;
  const payload = campaignId ? `${base}:${campaignId}` : base;
  return crypto
    .createHmac("sha256", secret())
    .update(payload)
    .digest("hex");
}

function buildUnsubscribeUrl({ email, category, campaignId }) {
  const base = (process.env.BACKEND_URL || process.env.APP_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
  const params = new URLSearchParams({ email, category, sig: sign(email, category, campaignId) });
  if (campaignId) params.set("campaign_id", String(campaignId));
  return `${base}/api/emails/unsubscribe?${params.toString()}`;
}

function verifyUnsubscribeToken({ email, category, sig, campaign_id: campaignId }) {
  if (!email || !category || !sig) return false;
  const expected = sign(email, category, campaignId ? Number(campaignId) : undefined);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { buildUnsubscribeUrl, verifyUnsubscribeToken };
