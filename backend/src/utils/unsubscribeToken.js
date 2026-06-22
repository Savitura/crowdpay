const crypto = require("crypto");

function secret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || "dev-unsubscribe-secret";
}

function sign(email, category) {
  return crypto
    .createHmac("sha256", secret())
    .update(`${email.toLowerCase()}:${category}`)
    .digest("hex");
}

function buildUnsubscribeUrl({ email, category }) {
  const base = (process.env.BACKEND_URL || process.env.APP_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
  const params = new URLSearchParams({ email, category, sig: sign(email, category) });
  return `${base}/api/emails/unsubscribe?${params.toString()}`;
}

function verifyUnsubscribeToken({ email, category, sig }) {
  if (!email || !category || !sig) return false;
  const expected = sign(email, category);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { buildUnsubscribeUrl, verifyUnsubscribeToken };
