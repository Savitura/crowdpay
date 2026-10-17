'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const ratesRouter = require('./rates');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rates', ratesRouter);
  return app;
}

test('GET /api/rates returns NGN exchange rates with approximate: true', async () => {
  const app = createApp();
  const response = await request(app).get('/api/rates');

  assert.equal(response.status, 200);
  assert.equal(response.body.target, 'NGN');
  assert.equal(response.body.approximate, true);
  assert.ok(typeof response.body.rates.USDC === 'number');
  assert.ok(response.body.rates.USDC > 0);
  assert.ok(typeof response.body.rates.XLM === 'number');
  assert.ok(response.body.rates.XLM > 0);
});

test('GET /api/rates/ngn returns NGN exchange rates', async () => {
  const app = createApp();
  const response = await request(app).get('/api/rates/ngn');

  assert.equal(response.status, 200);
  assert.equal(response.body.target, 'NGN');
  assert.equal(response.body.approximate, true);
  assert.ok(response.body.rates.USDC > 0);
});

test('GET /api/rates/estimate converts USDC amount to NGN', async () => {
  const app = createApp();
  const response = await request(app).get('/api/rates/estimate?amount=100&asset=USDC');

  assert.equal(response.status, 200);
  assert.equal(response.body.original_amount, 100);
  assert.equal(response.body.asset, 'USDC');
  assert.equal(response.body.target, 'NGN');
  assert.equal(response.body.approximate, true);
  assert.ok(response.body.amount > 0);
});

test('GET /api/rates/estimate returns 400 for invalid amount', async () => {
  const app = createApp();
  const response = await request(app).get('/api/rates/estimate?amount=abc');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Valid numeric amount is required/i);
});
