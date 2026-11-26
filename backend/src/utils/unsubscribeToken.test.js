const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildUnsubscribeUrl, verifyUnsubscribeToken } = require('./unsubscribeToken');

const EMAIL = 'Ada@Example.com';
const CATEGORY = 'campaign_updates';

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('builds a signed unsubscribe URL with the expected parameters', () => {
  withEnv({ UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret', FRONTEND_URL: 'https://crowdpay.example/' }, () => {
    const url = new URL(buildUnsubscribeUrl({ email: EMAIL, category: CATEGORY }));

    assert.equal(url.origin + url.pathname, 'https://crowdpay.example/settings/notifications');
    assert.equal(url.searchParams.get('email'), EMAIL);
    assert.equal(url.searchParams.get('category'), CATEGORY);
    assert.equal(url.searchParams.get('sig').length, 64);
    assert.equal(url.searchParams.get('campaign_id'), null);
  });
});

test('includes the campaign id when one is given', () => {
  withEnv({ UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret' }, () => {
    const url = new URL(
      buildUnsubscribeUrl({ email: EMAIL, category: CATEGORY, campaignId: 42 })
    );
    assert.equal(url.searchParams.get('campaign_id'), '42');
  });
});

test('verifies a token it produced', () => {
  withEnv({ UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret' }, () => {
    const url = new URL(buildUnsubscribeUrl({ email: EMAIL, category: CATEGORY, campaignId: 7 }));
    const params = Object.fromEntries(url.searchParams.entries());

    assert.equal(verifyUnsubscribeToken(params), true);
  });
});

test('rejects a tampered signature, email or category', () => {
  withEnv({ UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret' }, () => {
    const url = new URL(buildUnsubscribeUrl({ email: EMAIL, category: CATEGORY }));
    const params = Object.fromEntries(url.searchParams.entries());

    assert.equal(verifyUnsubscribeToken({ ...params, sig: 'deadbeef' }), false);
    assert.equal(verifyUnsubscribeToken({ ...params, email: 'attacker@example.com' }), false);
    assert.equal(verifyUnsubscribeToken({ ...params, category: 'weekly_digest' }), false);
    assert.equal(verifyUnsubscribeToken({ ...params, sig: undefined }), false);
  });
});

test('signs addresses case-insensitively but binds the campaign id', () => {
  withEnv({ UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret' }, () => {
    const url = new URL(buildUnsubscribeUrl({ email: EMAIL, category: CATEGORY, campaignId: 7 }));
    const params = Object.fromEntries(url.searchParams.entries());

    assert.equal(verifyUnsubscribeToken({ ...params, email: 'ada@example.com' }), true);
    assert.equal(verifyUnsubscribeToken({ ...params, campaign_id: '8' }), false);
  });
});

test('produces a deterministic HMAC signature', () => {
  withEnv({ UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret' }, () => {
    const url = new URL(buildUnsubscribeUrl({ email: EMAIL, category: CATEGORY }));
    const expected = crypto
      .createHmac('sha256', 'test-unsubscribe-secret')
      .update(`${EMAIL.toLowerCase()}:${CATEGORY}`)
      .digest('hex');

    assert.equal(url.searchParams.get('sig'), expected);
  });
});

test('throws when no signing secret is configured', () => {
  withEnv({ UNSUBSCRIBE_SECRET: undefined, JWT_SECRET: undefined }, () => {
    assert.throws(
      () => buildUnsubscribeUrl({ email: EMAIL, category: CATEGORY }),
      /UNSUBSCRIBE_SECRET/
    );
  });
});
