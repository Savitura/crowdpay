const test = require('node:test');
const assert = require('node:assert/strict');
const rateLimit = require('express-rate-limit');
const request = require('supertest');

process.env.TRUST_PROXY_HOPS = '1';
const app = require('./index');

test('trusts the configured Railway proxy hop so client rate limits use forwarded IPs', async () => {
  assert.equal(app.get('trust proxy'), 1);

  const limiter = rateLimit({ windowMs: 60_000, limit: 1 });
  app.get('/__test/proxy-rate-limit', limiter, (_req, res) => res.sendStatus(200));

  const firstClient = '198.51.100.10';
  const secondClient = '203.0.113.20';
  const firstRequest = await request(app)
    .get('/__test/proxy-rate-limit')
    .set('X-Forwarded-For', firstClient);
  const limitedRequest = await request(app)
    .get('/__test/proxy-rate-limit')
    .set('X-Forwarded-For', firstClient);
  const secondRequest = await request(app)
    .get('/__test/proxy-rate-limit')
    .set('X-Forwarded-For', secondClient);

  assert.equal(firstRequest.status, 200);
  assert.equal(limitedRequest.status, 429);
  assert.equal(secondRequest.status, 200);
});
