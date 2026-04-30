const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, stellarImpl }) {
  const stellarStub = {
    ensureCustodialAccountFundedAndTrusted: async () => {},
    ...stellarImpl,
  };

  const router = proxyquire('./auth', {
    '@stellar/stellar-sdk': {
      Keypair: {
        random: () => ({
          publicKey: () => 'GUSER',
          secret: () => 'SA3D5Z7Z7PLQANRPW6VYJEXAMPLE7WBZIY2ORP2X5Z5D4GS6Q27Q2H',
        }),
      },
    },
    '../config/database': { query: queryImpl },
    '../services/stellarService': stellarStub,
    '../services/walletSecrets': {
      encryptWalletSecret: async (secret) => `cpws:v1:${secret.slice(0, 8)}`,
    },
    '../services/emailService': {
      sendEmail: () => {},
    },
    '../middleware/auth': {
      requireAuth: (_req, _res, next) => next(),
    },
    jsonwebtoken: {
      sign: () => 'jwt-token',
    },
    bcryptjs: {
      hash: async () => 'hashed',
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  return app;
}

test('POST /api/auth/register encrypts wallet secret before insert and schedules funding', async () => {
  let ensureCalled = false;
  let insertedSecret = null;
  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT id FROM users WHERE email')) {
        return { rows: [] };
      }
      if (text.includes('INSERT INTO users')) {
        insertedSecret = params[4];
        return {
          rows: [
            {
              id: 'user-new',
              email: 'a@b.c',
              name: 'N',
              wallet_public_key: 'GUSER',
              role: 'contributor',
            },
          ],
        };
      }
      if (text.includes('INSERT INTO refresh_tokens')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    stellarImpl: {
      ensureCustodialAccountFundedAndTrusted: async ({ publicKey, secret }) => {
        assert.equal(publicKey, 'GUSER');
        assert.equal(secret, 'SA3D5Z7Z7PLQANRPW6VYJEXAMPLE7WBZIY2ORP2X5Z5D4GS6Q27Q2H');
        ensureCalled = true;
      },
    },
  });

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'a@b.c', password: 'Longpassword1', name: 'N' });

  assert.equal(res.status, 201);
  assert.equal(res.body.token, 'jwt-token');
  assert.notEqual(insertedSecret, 'SA3D5Z7Z7PLQANRPW6VYJEXAMPLE7WBZIY2ORP2X5Z5D4GS6Q27Q2H');
  assert.match(insertedSecret, /^cpws:v1:/);

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ensureCalled, true);
});
