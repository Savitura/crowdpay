// Keeps backend/docs/webhooks-integration.md in step with the signing code
// (#1118). The guide's test vector and its Node.js verification example are
// read from the Markdown file and checked against the real dispatcher, so a
// change to how deliveries are signed fails here until the guide is updated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const proxyquire = require('proxyquire').noCallThru();

const GUIDE_PATH = path.join(__dirname, '..', '..', 'docs', 'webhooks-integration.md');
const GUIDE = fs.readFileSync(GUIDE_PATH, 'utf8');
const VECTOR_KEYS = [
  'previous secret (v1)',
  'current secret (v2)',
  'X-CrowdPay-Event',
  'X-CrowdPay-Delivery-Id',
  'body',
  'X-CrowdPay-Signature',
];

// Returns the first fenced code block after `<!-- marker -->` in the guide.
function guideBlock(marker) {
  const start = GUIDE.indexOf(`<!-- ${marker} -->`);
  assert.notEqual(start, -1, `webhooks-integration.md has no <!-- ${marker} --> marker`);
  const match = /```\w*\r?\n([\s\S]*?)\r?\n```/.exec(GUIDE.slice(start));
  assert.ok(match, `no code block after <!-- ${marker} -->`);
  return match[1];
}

function readTestVector() {
  const vector = {};
  for (const line of guideBlock('signing-test-vector').split(/\r?\n/)) {
    const separator = line.indexOf(': ');
    if (separator > 0) vector[line.slice(0, separator)] = line.slice(separator + 2).trim();
  }
  return vector;
}

function loadVerifyExample() {
  const source = `${guideBlock('verify-example')}\nverifyCrowdPaySignature;`;
  return vm.runInNewContext(source, { require, Buffer });
}

const vector = readTestVector();
const previousSecret = vector['previous secret (v1)'];
const currentSecret = vector['current secret (v2)'];
const documentedHeader = vector['X-CrowdPay-Signature'];

function claimRow(overrides = {}) {
  return {
    id: vector['X-CrowdPay-Delivery-Id'],
    webhook_id: 'webhook-1',
    attempt_count: 1,
    payload: JSON.parse(vector.body),
    event_type: vector['X-CrowdPay-Event'],
    lease_token: 'lease-1',
    url: 'https://receiver.example/crowdpay/webhooks',
    secret: currentSecret,
    secret_version: 2,
    previous_secret: previousSecret,
    previous_secret_version: 1,
    previous_secret_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    backoff_strategy: null,
    owner_id: 'user-1',
    ...overrides,
  };
}

function loadDispatcher({ query = async () => ({ rows: [] }), safeFetch } = {}) {
  return proxyquire('./webhookDispatcher', {
    '../config/database': { query },
    '../config/logger': { error: () => {}, warn: () => {}, info: () => {} },
    './emailService': { sendEmail: async () => {} },
    './integrationSecrets': {
      isEncryptedIntegrationSecret: () => false,
      withDecryptedIntegrationSecret: async () => {},
    },
    '../utils/safeFetch': { safeFetch },
  });
}

// Drives one delivery attempt through the dispatcher and captures the request.
async function sendDelivery(row) {
  const requests = [];
  const query = async text => {
    if (/SET status = 'delivering', attempt_count/.test(text)) return { rows: [row] };
    if (/WHERE id = \$1 AND lease_token = \$2/.test(text)) return { rows: [{ id: row.id }] };
    return { rows: [] };
  };
  const safeFetch = async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  const { processDelivery } = loadDispatcher({ query, safeFetch });
  await processDelivery(row.id);
  assert.equal(requests.length, 1);
  return requests[0];
}

test('the guide test vector is complete', () => {
  for (const key of VECTOR_KEYS) {
    assert.ok(vector[key], `test vector is missing "${key}"`);
  }
});

test('hmacSignature reproduces the documented signatures', () => {
  const { hmacSignature } = loadDispatcher();
  const v2 = hmacSignature(currentSecret, vector.body);
  const v1 = hmacSignature(previousSecret, vector.body);
  assert.equal(`v2=${v2}, v1=${v1}`, documentedHeader);
});

test('a delivery in the rotation grace period sends the documented headers and body', async () => {
  const request = await sendDelivery(claimRow());

  assert.equal(request.method, 'POST');
  assert.equal(request.body, vector.body);
  assert.deepEqual(request.headers, {
    'Content-Type': 'application/json',
    'X-CrowdPay-Signature': documentedHeader,
    'X-CrowdPay-Event': vector['X-CrowdPay-Event'],
    'X-CrowdPay-Delivery-Id': vector['X-CrowdPay-Delivery-Id'],
  });
});

test('after the grace period only the current secret signs the delivery', async () => {
  const expired = new Date(Date.now() - 1000).toISOString();
  const request = await sendDelivery(claimRow({ previous_secret_expires_at: expired }));

  assert.equal(request.headers['X-CrowdPay-Signature'], documentedHeader.split(', ')[0]);
  assert.match(request.headers['X-CrowdPay-Signature'], /^v2=[0-9a-f]{64}$/);
});

test('the guide verification example accepts the vector with either secret', () => {
  const verifyCrowdPaySignature = loadVerifyExample();
  const body = Buffer.from(vector.body, 'utf8');

  assert.equal(verifyCrowdPaySignature(body, documentedHeader, [currentSecret]), true);
  assert.equal(verifyCrowdPaySignature(body, documentedHeader, [previousSecret]), true);
});

test('the verification example rejects a tampered body, a wrong secret or a bad header', () => {
  const verifyCrowdPaySignature = loadVerifyExample();
  const body = Buffer.from(vector.body, 'utf8');
  const tampered = Buffer.from(vector.body.replace('"funded"', '"failed"'), 'utf8');
  const secrets = [currentSecret, previousSecret];

  assert.notDeepEqual(tampered, body);
  assert.equal(verifyCrowdPaySignature(tampered, documentedHeader, secrets), false);
  assert.equal(verifyCrowdPaySignature(body, documentedHeader, ['whsec_wrong']), false);
  assert.equal(verifyCrowdPaySignature(body, undefined, secrets), false);
  assert.equal(verifyCrowdPaySignature(body, `sha256=${'0'.repeat(64)}`, secrets), false);
});
