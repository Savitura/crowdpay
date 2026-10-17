const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const geoip = require('./geoipService');
const {
  lookupIp,
  isGeoipEnabled,
  validateGeoipConfig,
  normalizeIp,
  isPublicIp,
  mapMaxmindRecord,
  resetGeoipState,
  FAILURE_THRESHOLD,
} = geoip;

const PUBLIC_IP = '203.0.113.5';
const GEOIP_VARS = [
  'GEOIP_PROVIDER',
  'GEOIP_TIMEOUT_MS',
  'GEOIP_CACHE_TTL_MS',
  'GEOIP_CACHE_MAX_ENTRIES',
  'GEOIP_MAXMIND_DB_PATH',
  'GEOIP_IPINFO_TOKEN',
];

const originalEnv = {};
const originalFetch = global.fetch;

/** Replace global fetch with a recording stub. */
function stubFetch(impl) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return impl(url, options);
  };
  return calls;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, statusText: 'stubbed', json: async () => body };
}

beforeEach(() => {
  for (const key of GEOIP_VARS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetGeoipState();
});

afterEach(() => {
  for (const key of GEOIP_VARS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  global.fetch = originalFetch;
  resetGeoipState();
});

test('normalizeIp reduces the address forms Express reports', () => {
  assert.equal(normalizeIp('203.0.113.5'), '203.0.113.5');
  assert.equal(normalizeIp('  203.0.113.5  '), '203.0.113.5');
  assert.equal(normalizeIp('::ffff:203.0.113.5'), '203.0.113.5', 'IPv4-mapped IPv6');
  assert.equal(normalizeIp('203.0.113.5:44321'), '203.0.113.5', 'host:port');
  assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1', 'bracketed IPv6 with port');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1', 'zone index');
  assert.equal(normalizeIp('203.0.113.5, 70.41.3.18'), '203.0.113.5', 'XFF chain takes the client');
});

test('normalizeIp rejects anything that is not an IP literal', () => {
  assert.equal(normalizeIp('not-an-ip'), null);
  assert.equal(normalizeIp('999.999.999.999'), null);
  assert.equal(normalizeIp(''), null);
  assert.equal(normalizeIp(null), null);
  assert.equal(normalizeIp(undefined), null);
  assert.equal(normalizeIp(12345), null);
});

test('isPublicIp excludes reserved IPv4 and IPv6 ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.10.1',
    '100.64.0.1',
    '0.0.0.0',
    '239.1.1.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.equal(isPublicIp(ip), false, `${ip} should be private`);
  }

  for (const ip of ['203.0.113.5', '8.8.8.8', '172.32.0.1', '2001:db8::1']) {
    assert.equal(isPublicIp(ip), true, `${ip} should be public`);
  }
});

test('lookups are disabled unless a provider is configured', async () => {
  const calls = stubFetch(() => jsonResponse({}));

  assert.equal(isGeoipEnabled(), false);
  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
  assert.equal(calls.length, 0, 'no provider should be contacted');
});

test('an unrecognized provider disables lookups instead of throwing', async () => {
  process.env.GEOIP_PROVIDER = 'not-a-provider';
  const calls = stubFetch(() => jsonResponse({}));

  assert.equal(isGeoipEnabled(), false);
  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
  assert.equal(calls.length, 0);
});

test('provider names inherited from Object.prototype are not treated as providers', async () => {
  const calls = stubFetch(() => jsonResponse({}));

  // A plain object would resolve these to inherited members and report the
  // provider as configured while every lookup silently failed.
  for (const value of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    process.env.GEOIP_PROVIDER = value;
    resetGeoipState();

    assert.equal(isGeoipEnabled(), false, `${value} should not enable lookups`);
    assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
    assert.throws(() => validateGeoipConfig(), /Unsupported GEOIP_PROVIDER/);
  }

  assert.equal(calls.length, 0);
});

test('private and malformed IPs never reach the provider', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  const calls = stubFetch(() => jsonResponse({ status: 'success', countryCode: 'US' }));

  for (const ip of ['127.0.0.1', '::1', '192.168.0.10', '::ffff:10.0.0.1', 'garbage', null]) {
    assert.deepEqual(await lookupIp(ip), { country: null, region: null, city: null });
  }

  assert.equal(calls.length, 0);
});

test('ip-api response maps to country/region/city', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  const calls = stubFetch(() =>
    jsonResponse({
      status: 'success',
      countryCode: 'US',
      regionName: 'California',
      city: 'San Francisco',
    })
  );

  assert.deepEqual(await lookupIp(PUBLIC_IP), {
    country: 'US',
    region: 'California',
    city: 'San Francisco',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^http:\/\/ip-api\.com\/json\/203\.0\.113\.5\?/);
});

test('ip-api failure status resolves to nulls without tripping the breaker', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  stubFetch(() => jsonResponse({ status: 'fail', message: 'reserved range' }));

  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
});

test('ipinfo sends its token as a bearer header, never in the URL', async () => {
  process.env.GEOIP_PROVIDER = 'ipinfo';
  process.env.GEOIP_IPINFO_TOKEN = 'secret-token';
  const calls = stubFetch(() => jsonResponse({ country: 'DE', region: 'Berlin', city: 'Berlin' }));

  assert.deepEqual(await lookupIp(PUBLIC_IP), {
    country: 'DE',
    region: 'Berlin',
    city: 'Berlin',
  });
  assert.equal(calls[0].url, 'https://ipinfo.io/203.0.113.5/json');
  assert.doesNotMatch(calls[0].url, /secret-token/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
});

test('ipinfo bogon responses resolve to nulls', async () => {
  process.env.GEOIP_PROVIDER = 'ipinfo';
  process.env.GEOIP_IPINFO_TOKEN = 'secret-token';
  stubFetch(() => jsonResponse({ ip: PUBLIC_IP, bogon: true }));

  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
});

test('ipinfo without a token fails open rather than calling the API', async () => {
  process.env.GEOIP_PROVIDER = 'ipinfo';
  const calls = stubFetch(() => jsonResponse({ country: 'DE' }));

  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
  assert.equal(calls.length, 0);
});

test('provider fields are trimmed, stripped of control characters, and capped', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  stubFetch(() =>
    jsonResponse({
      status: 'success',
      countryCode: '  US \n',
      regionName: `Cali${String.fromCharCode(7)}fornia`,
      city: 'x'.repeat(250),
    })
  );

  const location = await lookupIp(PUBLIC_IP);
  assert.equal(location.country, 'US');
  assert.equal(location.region, 'Cali fornia');
  assert.equal(location.city.length, 100);
});

test('missing provider fields become null rather than undefined', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  stubFetch(() => jsonResponse({ status: 'success', countryCode: 'JP' }));

  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: 'JP', region: null, city: null });
});

test('resolved IPs are cached, so repeat logins cost one lookup', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  const calls = stubFetch(() =>
    jsonResponse({ status: 'success', countryCode: 'US', city: 'Denver' })
  );

  const first = await lookupIp(PUBLIC_IP);
  const second = await lookupIp(`::ffff:${PUBLIC_IP}`);

  assert.deepEqual(second, first);
  assert.equal(calls.length, 1, 'the second lookup should be served from cache');
});

test('HTTP errors fail open', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  stubFetch(() => jsonResponse({}, { ok: false, status: 429 }));

  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
});

test('network errors and timeouts fail open', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  stubFetch(() => {
    throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  });

  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
});

test('the circuit breaker stops calling a provider that keeps failing', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  const calls = stubFetch(() => {
    throw new Error('connect ECONNREFUSED');
  });

  // Distinct IPs so the cache never short-circuits the call.
  for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
    await lookupIp(`203.0.113.${i + 10}`);
  }
  assert.equal(calls.length, FAILURE_THRESHOLD);

  await lookupIp('198.51.100.7');
  assert.equal(
    calls.length,
    FAILURE_THRESHOLD,
    'further lookups should be skipped during cooldown'
  );
});

test('a success resets the failure count before the breaker trips', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  let shouldFail = true;
  const calls = stubFetch(() => {
    if (shouldFail) throw new Error('transient');
    return jsonResponse({ status: 'success', countryCode: 'FR' });
  });

  for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) {
    await lookupIp(`203.0.113.${i + 10}`);
  }

  shouldFail = false;
  assert.deepEqual(await lookupIp('198.51.100.7'), { country: 'FR', region: null, city: null });

  shouldFail = true;
  await lookupIp('198.51.100.8');
  assert.equal(calls.length, FAILURE_THRESHOLD + 1, 'breaker should not have tripped');
});

test('maxmind records map country, first subdivision, and city', () => {
  assert.deepEqual(
    mapMaxmindRecord({
      country: { iso_code: 'GB' },
      subdivisions: [{ names: { en: 'England' } }, { names: { en: 'Greater London' } }],
      city: { names: { en: 'London' } },
    }),
    { country: 'GB', region: 'England', city: 'London' }
  );
});

test('maxmind records fall back to registered country and tolerate gaps', () => {
  assert.deepEqual(mapMaxmindRecord({ registered_country: { iso_code: 'NG' } }), {
    country: 'NG',
    region: null,
    city: null,
  });
  assert.deepEqual(mapMaxmindRecord(null), { country: null, region: null, city: null });
  assert.deepEqual(mapMaxmindRecord({}), { country: null, region: null, city: null });
});

test('maxmind without a database path fails open', async () => {
  process.env.GEOIP_PROVIDER = 'maxmind';

  assert.equal(isGeoipEnabled(), true);
  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
});

test('maxmind with an unreadable database fails open', async () => {
  process.env.GEOIP_PROVIDER = 'maxmind';
  process.env.GEOIP_MAXMIND_DB_PATH = '/nonexistent/GeoLite2-City.mmdb';

  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: null, region: null, city: null });
});

test('concurrent lookups of one IP collapse into a single provider call', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  const calls = stubFetch(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return jsonResponse({ status: 'success', countryCode: 'US', city: 'Denver' });
  });

  const results = await Promise.all(Array.from({ length: 25 }, () => lookupIp(PUBLIC_IP)));

  assert.equal(calls.length, 1, '25 concurrent lookups should share one call');
  for (const result of results) {
    assert.deepEqual(result, { country: 'US', region: null, city: 'Denver' });
  }
});

test('concurrent lookups of different IPs are not collapsed', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  const calls = stubFetch(async url => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return jsonResponse({
      status: 'success',
      countryCode: url.includes('198.51.100') ? 'FR' : 'US',
    });
  });

  const [a, b] = await Promise.all([lookupIp(PUBLIC_IP), lookupIp('198.51.100.7')]);

  assert.equal(calls.length, 2);
  assert.equal(a.country, 'US');
  assert.equal(b.country, 'FR');
});

test('a shared in-flight lookup is released so later lookups still work', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  let failNext = true;
  const calls = stubFetch(async () => {
    if (failNext) throw new Error('transient');
    return jsonResponse({ status: 'success', countryCode: 'US' });
  });

  // Two concurrent callers share one failing lookup; nothing is cached.
  const failed = await Promise.all([lookupIp(PUBLIC_IP), lookupIp(PUBLIC_IP)]);
  assert.equal(calls.length, 1);
  for (const result of failed) {
    assert.deepEqual(result, { country: null, region: null, city: null });
  }

  failNext = false;
  assert.deepEqual(await lookupIp(PUBLIC_IP), { country: 'US', region: null, city: null });
  assert.equal(calls.length, 2, 'a failed lookup must not be cached or stuck in flight');
});

test('the cache is bounded, evicting the least recently used IP', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  process.env.GEOIP_CACHE_MAX_ENTRIES = '3';
  const calls = stubFetch(url => jsonResponse({ status: 'success', countryCode: 'US', city: url }));

  // Fill the cache to its limit.
  await lookupIp('198.51.100.1');
  await lookupIp('198.51.100.2');
  await lookupIp('198.51.100.3');
  assert.equal(calls.length, 3);

  // Touch .1 so .2 becomes the least recently used entry.
  await lookupIp('198.51.100.1');
  assert.equal(calls.length, 3, 'that lookup should have been a cache hit');

  // A fourth distinct IP evicts .2, not .1.
  await lookupIp('198.51.100.4');
  assert.equal(calls.length, 4);

  await lookupIp('198.51.100.1');
  assert.equal(calls.length, 4, '.1 should still be cached');

  await lookupIp('198.51.100.2');
  assert.equal(calls.length, 5, '.2 should have been evicted');
});

test('cache growth stays bounded under rotating attacker-controlled IPs', async () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  process.env.GEOIP_CACHE_MAX_ENTRIES = '50';
  stubFetch(() => jsonResponse({ status: 'success', countryCode: 'US' }));

  for (let i = 0; i < 500; i += 1) {
    await lookupIp(`198.51.${Math.floor(i / 256)}.${i % 256}`);
  }

  // The 51st distinct IP evicted the 1st, so the earliest entries are gone
  // and must be re-fetched rather than served from an ever-growing map.
  const recheck = stubFetch(() => jsonResponse({ status: 'success', countryCode: 'US' }));
  await lookupIp('198.51.0.0');
  assert.equal(recheck.length, 1, 'the oldest entry should have been evicted');
});

test('validateGeoipConfig accepts an unset or disabled provider', () => {
  assert.doesNotThrow(() => validateGeoipConfig());

  process.env.GEOIP_PROVIDER = 'none';
  assert.doesNotThrow(() => validateGeoipConfig());
});

test('validateGeoipConfig rejects a provider that cannot work', () => {
  process.env.GEOIP_PROVIDER = 'ipinfo';
  assert.throws(() => validateGeoipConfig(), /GEOIP_IPINFO_TOKEN is required/);

  process.env.GEOIP_IPINFO_TOKEN = 'a-token';
  assert.doesNotThrow(() => validateGeoipConfig());

  process.env.GEOIP_PROVIDER = 'maxmind';
  assert.throws(() => validateGeoipConfig(), /GEOIP_MAXMIND_DB_PATH is required/);

  process.env.GEOIP_MAXMIND_DB_PATH = '/nonexistent/GeoLite2-City.mmdb';
  assert.throws(() => validateGeoipConfig(), /does not exist/);
});

test('validateGeoipConfig rejects unparseable numeric settings', () => {
  process.env.GEOIP_PROVIDER = 'ip-api';
  assert.doesNotThrow(() => validateGeoipConfig());

  for (const key of ['GEOIP_TIMEOUT_MS', 'GEOIP_CACHE_TTL_MS', 'GEOIP_CACHE_MAX_ENTRIES']) {
    process.env[key] = 'soon';
    assert.throws(() => validateGeoipConfig(), new RegExp(`${key} must be a positive number`));

    process.env[key] = '0';
    assert.throws(() => validateGeoipConfig(), new RegExp(`${key} must be a positive number`));

    process.env[key] = '1000';
    assert.doesNotThrow(() => validateGeoipConfig());
    delete process.env[key];
  }
});
