const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const SAN_FRANCISCO = { country: 'US', region: 'California', city: 'San Francisco' };
const NO_LOCATION = { country: null, region: null, city: null };

function buildSessionService(queryImpl, location = SAN_FRANCISCO) {
  const lookups = [];
  const service = proxyquire('./sessionService', {
    '../config/database': { query: queryImpl },
    './geoipService': {
      lookupIp: async ip => {
        lookups.push(ip);
        return location;
      },
    },
  });
  return { ...service, lookups };
}

function buildRequest(overrides = {}) {
  return {
    headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US' },
    ip: '203.0.113.5',
    ...overrides,
  };
}

test('createUserSession stores the resolved country, region, and city', async () => {
  const calls = [];
  const queryImpl = async (text, params) => {
    calls.push({ text, params });
    if (text.includes('SELECT COUNT(*)')) return { rows: [{ count: 0 }] };
    return { rows: [{ id: 'session-1' }] };
  };

  const { createUserSession, lookups } = buildSessionService(queryImpl);
  await createUserSession('user-1', 'token-1', buildRequest());

  assert.deepEqual(lookups, ['203.0.113.5']);

  const insert = calls.find(call => call.text.includes('INSERT INTO user_sessions'));
  assert.ok(insert, 'expected a user_sessions insert');
  assert.match(insert.text, /location_country, location_region, location_city/);
  assert.deepEqual(insert.params.slice(-3), ['US', 'California', 'San Francisco']);
});

test('createUserSession stores nulls when the IP cannot be located', async () => {
  const calls = [];
  const queryImpl = async (text, params) => {
    calls.push({ text, params });
    if (text.includes('SELECT COUNT(*)')) return { rows: [{ count: 0 }] };
    return { rows: [{ id: 'session-1' }] };
  };

  const { createUserSession } = buildSessionService(queryImpl, NO_LOCATION);
  await createUserSession('user-1', 'token-1', buildRequest({ ip: '127.0.0.1' }));

  const insert = calls.find(call => call.text.includes('INSERT INTO user_sessions'));
  assert.deepEqual(insert.params.slice(-3), [null, null, null]);
});

test('listUserSessions renders city, region, and country', async () => {
  const queryImpl = async () => ({
    rows: [
      {
        id: 'session-1',
        device_fingerprint: 'abcdef1234567890',
        ip_address: '203.0.113.5',
        user_agent: 'Mozilla/5.0',
        location_country: 'US',
        location_region: 'California',
        location_city: 'San Francisco',
        last_seen_at: '2026-07-27T00:00:00Z',
      },
    ],
  });

  const { listUserSessions } = buildSessionService(queryImpl);
  const [session] = await listUserSessions('user-1');

  assert.equal(session.location, 'San Francisco, California, US');
  assert.equal(session.device, 'Device abcdef12');
});

test('listUserSessions renders whichever location parts resolved', async () => {
  const queryImpl = async () => ({
    rows: [
      {
        id: 'session-1',
        ip_address: '203.0.113.5',
        location_country: 'US',
        location_region: null,
        location_city: null,
      },
    ],
  });

  const { listUserSessions } = buildSessionService(queryImpl);
  const [session] = await listUserSessions('user-1');

  assert.equal(session.location, 'US');
});

test('listUserSessions falls back to the IP when no location resolved', async () => {
  const queryImpl = async () => ({
    rows: [
      {
        id: 'session-1',
        ip_address: '203.0.113.5',
        location_country: null,
        location_region: null,
        location_city: null,
      },
    ],
  });

  const { listUserSessions } = buildSessionService(queryImpl);
  const [session] = await listUserSessions('user-1');

  assert.equal(session.location, '203.0.113.5');
});

test('recordLoginAttempt resolves the location from the IP by default', async () => {
  const calls = [];
  const queryImpl = async (text, params) => {
    calls.push({ text, params });
    return { rows: [] };
  };

  const { recordLoginAttempt, lookups } = buildSessionService(queryImpl);
  await recordLoginAttempt({
    email: 'someone@example.com',
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0',
    success: false,
    failureReason: 'Invalid credentials',
  });

  assert.deepEqual(lookups, ['203.0.113.5']);
  assert.match(calls[0].text, /INSERT INTO login_attempts/);
  assert.deepEqual(calls[0].params.slice(-3), ['US', 'California', 'San Francisco']);
});

test('recordLoginAttempt honours an explicitly supplied location', async () => {
  const calls = [];
  const queryImpl = async (text, params) => {
    calls.push({ text, params });
    return { rows: [] };
  };

  const { recordLoginAttempt, lookups } = buildSessionService(queryImpl);
  await recordLoginAttempt({
    email: 'someone@example.com',
    ip: '203.0.113.5',
    success: true,
    locationCountry: 'NG',
    locationCity: 'Lagos',
  });

  assert.deepEqual(lookups, [], 'a supplied location should not trigger a lookup');
  assert.deepEqual(calls[0].params.slice(-3), ['NG', null, 'Lagos']);
});

test('checkLoginAnomalies records the region on new-device and new-location alerts', async () => {
  const calls = [];
  const queryImpl = async (text, params) => {
    calls.push({ text, params });
    // No prior devices and no prior sessions in this country.
    if (text.includes('SELECT 1 FROM user_sessions')) return { rows: [] };
    return { rows: [] };
  };

  const { checkLoginAnomalies } = buildSessionService(queryImpl);
  const alerts = await checkLoginAnomalies('user-1', 'someone@example.com', buildRequest());

  assert.deepEqual(alerts, ['new_device', 'new_location']);

  const inserts = calls.filter(call => call.text.includes('INSERT INTO login_alerts'));
  assert.equal(inserts.length, 2);
  for (const insert of inserts) {
    assert.match(insert.text, /location_country, location_region, location_city/);
    assert.deepEqual(insert.params.slice(4, 7), ['US', 'California', 'San Francisco']);
  }
});
