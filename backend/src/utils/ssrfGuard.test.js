'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateHost,
  isBlockedHostname,
  isSafeUrl,
} = require('./ssrfGuard');

// ── isPrivateIpv4 ───────────────────────────────────────────────────────────
const ipv4Private = [
  '0.0.0.0',
  '0.255.255.255',
  '10.0.0.1',
  '10.255.255.254',
  '127.0.0.1',
  '127.255.255.255',
  '169.254.0.1',
  '169.254.255.254',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.0.1',
  '192.168.255.254',
  '100.64.0.1',
  '100.127.255.254',
  '198.18.0.1',
  '198.19.255.254',
  '224.0.0.1',
  '239.255.255.255',
  '255.255.255.255',
];

const ipv4Public = ['8.8.8.8', '1.1.1.1', '52.84.123.45'];

for (const ip of ipv4Private) {
  test(`isPrivateIpv4 detects ${ip} as private`, () => {
    assert.equal(isPrivateIpv4(ip), true);
  });
}

for (const ip of ipv4Public) {
  test(`isPrivateIpv4 detects ${ip} as public`, () => {
    assert.equal(isPrivateIpv4(ip), false);
  });
}

test('isPrivateIpv4 rejects malformed input', () => {
  assert.equal(isPrivateIpv4('not.an.ip'), true);
  assert.equal(isPrivateIpv4(''), true);
  assert.equal(isPrivateIpv4('256.256.256.256'), true);
});

// ── isPrivateIpv6 ───────────────────────────────────────────────────────────
const ipv6Private = [
  '::',
  '::1',
  'fc00::1',
  'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'fe80::1',
  'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'ff00::1',
  'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
];

const ipv6Public = ['2001:4860:4860::8888', '2606:4700:4700::1111'];

for (const ip of ipv6Private) {
  test(`isPrivateIpv6 detects ${ip} as private`, () => {
    assert.equal(isPrivateIpv6(ip), true);
  });
}

for (const ip of ipv6Public) {
  test(`isPrivateIpv6 detects ${ip} as public`, () => {
    assert.equal(isPrivateIpv6(ip), false);
  });
}

test('isPrivateIpv6 detects IPv4-mapped IPv6 as private', () => {
  assert.equal(isPrivateIpv6('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateIpv6('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIpv6('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateIpv6('::ffff:192.168.1.1'), true);
});

test('isPrivateIpv6 detects IPv4-mapped IPv6 as public', () => {
  assert.equal(isPrivateIpv6('::ffff:8.8.8.8'), false);
});

// ── isBlockedHostname ───────────────────────────────────────────────────────
test('isBlockedHostname detects known cloud metadata endpoints', () => {
  assert.equal(isBlockedHostname('169.254.169.254'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedHostname('metadata'), true);
  assert.equal(isBlockedHostname('169.254.169.253'), true);
});

test('isBlockedHostname is case insensitive', () => {
  assert.equal(isBlockedHostname('METADATA.GOOGLE.INTERNAL'), true);
  assert.equal(isBlockedHostname('Metadata'), true);
});

test('isBlockedHostname allows normal hostnames', () => {
  assert.equal(isBlockedHostname('example.com'), false);
  assert.equal(isBlockedHostname('api.crowdpay.com'), false);
});

// ── isPrivateHost ───────────────────────────────────────────────────────────
test('isPrivateHost handles bracketed IPv6', () => {
  assert.equal(isPrivateHost('[::1]'), true);
  assert.equal(isPrivateHost('[fe80::1]'), true);
});

test('isPrivateHost handles zone-indexed IPv6', () => {
  assert.equal(isPrivateHost('fe80::1%eth0'), true);
  assert.equal(isPrivateHost('::1%lo'), true);
});

test('isPrivateHost returns false for public hostnames (DNS resolution required)', () => {
  assert.equal(isPrivateHost('example.com'), false);
  assert.equal(isPrivateHost('api.github.com'), false);
});

test('isPrivateHost defaults to true for empty/missing input', () => {
  assert.equal(isPrivateHost(''), true);
  assert.equal(isPrivateHost(null), true);
  assert.equal(isPrivateHost(undefined), true);
});

// ── isSafeUrl ───────────────────────────────────────────────────────────────
test('isSafeUrl allows public HTTPS URL', async () => {
  const result = await isSafeUrl('https://example.com/hook');
  assert.equal(result.safe, true);
});

test('isSafeUrl allows HTTPS URL with IP (public)', async () => {
  const result = await isSafeUrl('https://8.8.8.8/hook');
  assert.equal(result.safe, true);
});

test('isSafeUrl blocks HTTPS URL with private IP (192.168.x.x)', async () => {
  const result = await isSafeUrl('https://192.168.1.1/hook');
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

test('isSafeUrl blocks HTTPS URL with cloud metadata IP', async () => {
  const result = await isSafeUrl('https://169.254.169.254/latest/meta-data/');
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

test('isSafeUrl blocks HTTPS URL with loopback IP', async () => {
  const result = await isSafeUrl('https://127.0.0.1/admin');
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

test('isSafeUrl blocks HTTPS URL with 10.x.x.x private range', async () => {
  const result = await isSafeUrl('https://10.0.0.1/api');
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

test('isSafeUrl blocks HTTPS URL with blocked hostname (metadata.google.internal)', async () => {
  const result = await isSafeUrl('https://metadata.google.internal/');
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

test('isSafeUrl blocks HTTP URL for non-localhost in production', async () => {
  // Simulate production-like behavior by setting allowLocalhostHttp = false
  const result = await isSafeUrl('http://example.com/hook', { allowLocalhostHttp: false });
  assert.equal(result.safe, false);
  assert.match(result.reason, /HTTP/);
});

test('isSafeUrl blocks ftp:// protocol', async () => {
  const result = await isSafeUrl('ftp://example.com/data');
  assert.equal(result.safe, false);
  assert.match(result.reason, /protocol/);
});

test('isSafeUrl blocks file:// protocol', async () => {
  const result = await isSafeUrl('file:///etc/passwd');
  assert.equal(result.safe, false);
  assert.match(result.reason, /protocol/);
});

test('isSafeUrl blocks empty/invalid URLs', async () => {
  const result = await isSafeUrl('');
  assert.equal(result.safe, false);
  assert.match(result.reason, /Invalid URL/);
});

test('isSafeUrl blocks javascript: URLs', async () => {
  const result = await isSafeUrl('javascript:alert(1)');
  assert.equal(result.safe, false);
  // The URL parser rejects this as invalid
  assert.ok(result.reason.length > 0);
});

test('isSafeUrl blocks link-local IPv6', async () => {
  const result = await isSafeUrl('https://[fe80::1]/hook');
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

test('isSafeUrl blocks ULA IPv6', async () => {
  const result = await isSafeUrl('https://[fc00::1]/hook');
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

test('isSafeUrl blocks multicast IPv6', async () => {
  const result = await isSafeUrl('https://[ff02::1]/hook');
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

// DNS-dependent tests — these require actual DNS resolution
test('isSafeUrl blocks hostname resolving to private IP', async () => {
  // localhost always resolves to 127.0.0.1 or ::1
  const result = await isSafeUrl('https://localhost/admin', { allowLocalhostHttp: false });
  assert.equal(result.safe, false);
  assert.match(result.reason, /private.internal/);
});

test('isSafeUrl allows real public hostname (DNS resolution)', async () => {
  const result = await isSafeUrl('https://example.com/hook');
  assert.equal(result.safe, true);
});

// In test env (NODE_ENV=test), HTTP localhost is allowed
test('isSafeUrl allows http://localhost in test environment (default)', async () => {
  const result = await isSafeUrl('http://localhost:3001/hook');
  assert.equal(result.safe, true);
});

test('isSafeUrl allows http://127.0.0.1 in test environment (default)', async () => {
  const result = await isSafeUrl('http://127.0.0.1:3001/hook');
  assert.equal(result.safe, true);
});
