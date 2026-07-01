const crypto = require('crypto');
const ff = require('./featureFlags');

function isKycRequiredForCampaigns() {
  return ff.isEnabled('kyc-required-for-campaigns');
}

function appBaseUrl() {
  return (process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function devKycSession({ user }) {
  const reference = `dev_kyc_${user.id}_${crypto.randomBytes(8).toString('hex')}`;
  return {
    provider: 'dev',
    providerReference: reference,
    redirectUrl: `${appBaseUrl()}/dashboard?kyc=started&reference=${encodeURIComponent(reference)}`,
    sessionToken: reference,
  };
}

async function createPersonaInquiry({ user }) {
  if (!process.env.PERSONA_API_KEY || !process.env.PERSONA_TEMPLATE_ID) {
    return devKycSession({ user });
  }

  const response = await fetch('https://withpersona.com/api/v1/inquiries', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      data: {
        type: 'inquiry',
        attributes: {
          'inquiry-template-id': process.env.PERSONA_TEMPLATE_ID,
          'reference-id': user.id,
          'redirect-uri': `${appBaseUrl()}/dashboard?kyc=returned`,
          fields: {
            name: user.name,
            email: user.email,
          },
        },
      },
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || 'Could not create KYC session';
    throw new Error(message);
  }

  const inquiry = body.data || {};
  return {
    provider: 'persona',
    providerReference: inquiry.id,
    redirectUrl: inquiry.attributes?.['inquiry-url'] || inquiry.attributes?.['hosted-inquiry-url'],
    sessionToken: inquiry.attributes?.['session-token'] || null,
  };
}

async function createKycSession({ user }) {
  const provider = String(process.env.KYC_PROVIDER || 'persona').toLowerCase();

  if (provider === 'persona') {
    return createPersonaInquiry({ user });
  }

  return devKycSession({ user });
}

function extractWebhookResult(payload = {}) {
  const data = payload.data || payload;
  const attrs = data.attributes || {};
  const nested = attrs.payload?.data || payload.payload?.data || {};
  const nestedAttrs = nested.attributes || {};
  const eventName = attrs.name || data.type || payload.event || payload.type || '';
  const status =
    nestedAttrs.status ||
    nestedAttrs['review-status'] ||
    attrs.status ||
    attrs['review-status'] ||
    payload.status ||
    payload.verification?.status ||
    '';
  const reference =
    nested.id ||
    data.id ||
    nestedAttrs['inquiry-id'] ||
    nestedAttrs.inquiry_id ||
    attrs['inquiry-id'] ||
    attrs.inquiry_id ||
    payload.inquiry_id ||
    payload.applicant_id ||
    payload.verification?.id ||
    payload.resource?.id ||
    null;
  const userId =
    nestedAttrs['reference-id'] ||
    nestedAttrs.reference_id ||
    attrs['reference-id'] ||
    attrs.reference_id ||
    payload.reference_id ||
    payload.vendorData ||
    payload.verification?.vendorData ||
    payload.user_id ||
    null;

  const reason =
    nestedAttrs['decline-reason'] ||
    nestedAttrs.decline_reason ||
    nestedAttrs['failure-reason'] ||
    nestedAttrs.failure_reason ||
    attrs['decline-reason'] ||
    attrs.decline_reason ||
    attrs.note ||
    payload.reason ||
    null;

  const normalized = String(status || eventName).toLowerCase();
  let kycStatus = 'pending';
  if (
    normalized.includes('approved') ||
    normalized.includes('completed') ||
    normalized.includes('verified') ||
    normalized === 'success' ||
    normalized.includes('passed')
  ) {
    kycStatus = 'verified';
  } else if (
    normalized.includes('declined') ||
    normalized.includes('failed') ||
    normalized.includes('rejected') ||
    normalized.includes('expired')
  ) {
    kycStatus = 'rejected';
  }

  return { providerReference: reference, userId, kycStatus, reason };
}

function verifyPersonaWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.PERSONA_WEBHOOK_SECRET;
  if (!secret) {
    return process.env.NODE_ENV === 'test' || String(process.env.KYC_PROVIDER || '').toLowerCase() === 'dev';
  }

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  const parts = signatureHeader.split(',');
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }

  if (!timestamp || !signatures.length) {
    return false;
  }

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${bodyStr}`)
    .digest('hex');

  return signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

module.exports = {
  createKycSession,
  extractWebhookResult,
  isKycRequiredForCampaigns,
  verifyPersonaWebhookSignature,
};
