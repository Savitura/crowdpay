const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

const ENV_KEYS = [
  'KYC_PROVIDER',
  'PERSONA_API_KEY',
  'PERSONA_TEMPLATE_ID',
  'PERSONA_WEBHOOK_SECRET',
  'APP_BASE_URL',
  'FRONTEND_URL',
  'NODE_ENV',
];

function saveEnv() {
  const snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function loadKycProvider({ featureEnabled = false, fetchImpl, warnings = [] } = {}) {
  return proxyquire('./kycProvider', {
    './featureFlags': {
      isEnabled: name => (name === 'kyc-required-for-campaigns' ? featureEnabled : false),
    },
    '../config/logger': {
      info: () => {},
      warn: (msg, meta) => warnings.push({ msg, meta }),
      error: () => {},
      debug: () => {},
    },
    '../utils/fetchWithTimeout': {
      fetchWithTimeout:
        fetchImpl ||
        (async () => {
          throw new Error('fetchWithTimeout not mocked');
        }),
    },
  });
}

test('isKycRequiredForCampaigns delegates to featureFlags', () => {
  assert.equal(loadKycProvider({ featureEnabled: true }).isKycRequiredForCampaigns(), true);
  assert.equal(loadKycProvider({ featureEnabled: false }).isKycRequiredForCampaigns(), false);
});

test('createKycSession creates a dev session with normalized redirectUrl', async () => {
  const env = saveEnv();
  try {
    process.env.KYC_PROVIDER = 'dev';
    process.env.APP_BASE_URL = 'https://app.crowdpay.test/';
    const kyc = loadKycProvider();

    const session = await kyc.createKycSession({
      user: { id: 'user-42', name: 'Ada', email: 'ada@example.com' },
    });

    assert.equal(session.provider, 'dev');
    assert.match(session.providerReference, /^dev_kyc_user-42_[0-9a-f]{16}$/);
    assert.equal(session.sessionToken, session.providerReference);
    assert.equal(
      session.redirectUrl,
      `https://app.crowdpay.test/dashboard?kyc=started&reference=${encodeURIComponent(session.providerReference)}`
    );
  } finally {
    restoreEnv(env);
  }
});

test('createKycSession throws when Persona env vars are missing', async () => {
  const env = saveEnv();
  try {
    delete process.env.KYC_PROVIDER;
    delete process.env.PERSONA_API_KEY;
    delete process.env.PERSONA_TEMPLATE_ID;
    const kyc = loadKycProvider();

    await assert.rejects(
      () => kyc.createKycSession({ user: { id: 'u1', name: 'Ada', email: 'ada@example.com' } }),
      /Persona KYC is not configured/
    );
  } finally {
    restoreEnv(env);
  }
});

test('createKycSession throws on unsupported KYC_PROVIDER', async () => {
  const env = saveEnv();
  try {
    process.env.KYC_PROVIDER = 'sumsub';
    const kyc = loadKycProvider();

    await assert.rejects(
      () => kyc.createKycSession({ user: { id: 'u1' } }),
      /Unsupported KYC_PROVIDER "sumsub"/
    );
  } finally {
    restoreEnv(env);
  }
});

test('createKycSession creates a Persona inquiry and maps response fields', async () => {
  const env = saveEnv();
  try {
    process.env.KYC_PROVIDER = 'persona';
    process.env.PERSONA_API_KEY = 'persona_key_123';
    process.env.PERSONA_TEMPLATE_ID = 'tmpl_abc';
    process.env.FRONTEND_URL = 'https://crowdpay.example/';

    const calls = [];
    const kyc = loadKycProvider({
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 201,
          json: async () => ({
            data: {
              id: 'inq_123',
              attributes: {
                'hosted-inquiry-url': 'https://withpersona.com/verify?inquiry-id=inq_123',
                'session-token': 'sess_tok_999',
              },
            },
          }),
        };
      },
    });

    const session = await kyc.createKycSession({
      user: { id: 'user-7', name: 'Grace Hopper', email: 'grace@example.com' },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://withpersona.com/api/v1/inquiries');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer persona_key_123');

    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.data.attributes['inquiry-template-id'], 'tmpl_abc');
    assert.equal(payload.data.attributes['reference-id'], 'user-7');
    assert.equal(
      payload.data.attributes['redirect-uri'],
      'https://crowdpay.example/dashboard?kyc=returned'
    );
    assert.deepEqual(payload.data.attributes.fields, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
    });

    assert.deepEqual(session, {
      provider: 'persona',
      providerReference: 'inq_123',
      redirectUrl: 'https://withpersona.com/verify?inquiry-id=inq_123',
      sessionToken: 'sess_tok_999',
    });
  } finally {
    restoreEnv(env);
  }
});

test('createKycSession propagates Persona API error detail, title, fallback, and network errors', async () => {
  const env = saveEnv();
  try {
    process.env.KYC_PROVIDER = 'persona';
    process.env.PERSONA_API_KEY = 'persona_key_123';
    process.env.PERSONA_TEMPLATE_ID = 'tmpl_abc';

    const kycWithDetail = loadKycProvider({
      fetchImpl: async () => ({
        ok: false,
        status: 422,
        json: async () => ({ errors: [{ detail: 'Invalid template id', title: 'Unprocessable' }] }),
      }),
    });
    await assert.rejects(
      () => kycWithDetail.createKycSession({ user: { id: 'u1', name: 'A', email: 'a@b.com' } }),
      /Invalid template id/
    );

    const kycWithTitle = loadKycProvider({
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ errors: [{ title: 'Unauthorized' }] }),
      }),
    });
    await assert.rejects(
      () => kycWithTitle.createKycSession({ user: { id: 'u1', name: 'A', email: 'a@b.com' } }),
      /Unauthorized/
    );

    const warnings = [];
    const kycWithBadJson = loadKycProvider({
      warnings,
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('Unexpected token <');
        },
      }),
    });
    await assert.rejects(
      () => kycWithBadJson.createKycSession({ user: { id: 'u1', name: 'A', email: 'a@b.com' } }),
      /Could not create KYC session/
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].meta.status, 502);

    const kycWithNetworkErr = loadKycProvider({
      fetchImpl: async () => {
        throw new Error('Request timed out');
      },
    });
    await assert.rejects(
      () => kycWithNetworkErr.createKycSession({ user: { id: 'u1', name: 'A', email: 'a@b.com' } }),
      /Request timed out/
    );
  } finally {
    restoreEnv(env);
  }
});

test('determineVerificationTier and getTierLimit map checks, packages, tags, and limits', () => {
  const kyc = loadKycProvider();

  assert.equal(kyc.determineVerificationTier({}), 'basic');
  assert.equal(
    kyc.determineVerificationTier({
      data: { attributes: { checks: [{ type: 'government-id' }] } },
    }),
    'basic'
  );
  assert.equal(
    kyc.determineVerificationTier({
      data: {
        attributes: {
          checks: [{ name: 'government_id' }, { 'check-type': 'proof-of-address' }],
        },
      },
    }),
    'standard'
  );
  assert.equal(
    kyc.determineVerificationTier({
      payload: {
        data: {
          attributes: {
            'verification-packages': [
              { methods: [{ name: 'document' }, { name: 'address' }, { name: 'selfie' }] },
            ],
          },
        },
      },
    }),
    'enhanced'
  );
  assert.equal(
    kyc.determineVerificationTier({
      data: { attributes: { tags: ['liveness'] } },
    }),
    'enhanced'
  );
  assert.equal(
    kyc.determineVerificationTier({
      data: { attributes: { tags: ['address'] } },
    }),
    'standard'
  );

  assert.equal(kyc.getTierLimit('none'), 0);
  assert.equal(kyc.getTierLimit('basic'), 5000);
  assert.equal(kyc.getTierLimit('standard'), 50000);
  assert.equal(kyc.getTierLimit('enhanced'), Infinity);
  assert.equal(kyc.getTierLimit('unknown'), 0);
});

test('extractWebhookResult maps approved, declined, and pending statuses and metadata', () => {
  const kyc = loadKycProvider();

  const approved = kyc.extractWebhookResult({
    data: {
      id: 'evt_1',
      attributes: {
        name: 'inquiry.completed',
        payload: {
          data: {
            id: 'inq_999',
            attributes: {
              status: 'approved',
              'reference-id': 'user-99',
              checks: [{ type: 'government-id' }, { type: 'address' }],
            },
          },
        },
      },
    },
  });
  assert.deepEqual(approved, {
    providerReference: 'inq_999',
    userId: 'user-99',
    kycStatus: 'verified',
    verificationStatus: 'approved',
    tier: 'standard',
    reason: null,
  });

  const declined = kyc.extractWebhookResult({
    data: {
      id: 'inq_555',
      attributes: {
        status: 'declined',
        reference_id: 'user-55',
        'decline-reason': 'Expired ID document',
      },
    },
  });
  assert.deepEqual(declined, {
    providerReference: 'inq_555',
    userId: 'user-55',
    kycStatus: 'rejected',
    verificationStatus: 'declined',
    tier: 'none',
    reason: 'Expired ID document',
  });

  const pending = kyc.extractWebhookResult({
    inquiry_id: 'inq_111',
    user_id: 'user-11',
    status: 'created',
  });
  assert.deepEqual(pending, {
    providerReference: 'inq_111',
    userId: 'user-11',
    kycStatus: 'pending',
    verificationStatus: 'pending',
    tier: 'none',
    reason: null,
  });
});

test('verifyPersonaWebhookSignature handles missing secret, malformed headers, and HMAC verification', () => {
  const env = saveEnv();
  try {
    const kyc = loadKycProvider();

    delete process.env.PERSONA_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'test';
    assert.equal(kyc.verifyPersonaWebhookSignature('{}', ''), true);

    process.env.NODE_ENV = 'production';
    process.env.KYC_PROVIDER = 'persona';
    assert.equal(kyc.verifyPersonaWebhookSignature('{}', ''), false);

    process.env.KYC_PROVIDER = 'dev';
    assert.equal(kyc.verifyPersonaWebhookSignature('{}', ''), true);

    process.env.PERSONA_WEBHOOK_SECRET = 'whsec_test_secret';
    const rawBody = Buffer.from('{"data":{"id":"inq_1"}}', 'utf8');
    const timestamp = '1700000000';
    const validSig = crypto
      .createHmac('sha256', 'whsec_test_secret')
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    assert.equal(kyc.verifyPersonaWebhookSignature(rawBody, null), false);
    assert.equal(kyc.verifyPersonaWebhookSignature(rawBody, 't=1700000000'), false);
    assert.equal(
      kyc.verifyPersonaWebhookSignature(rawBody, `t=${timestamp},v1=deadbeef,v1=${validSig}`),
      true
    );
    assert.equal(
      kyc.verifyPersonaWebhookSignature('{"tampered":true}', `t=${timestamp},v1=${validSig}`),
      false
    );
  } finally {
    restoreEnv(env);
  }
});
