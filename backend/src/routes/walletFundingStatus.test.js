const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire');

const mockAuthMiddleware = {
  requireAuth: (req, res, next) => {
    if (!req.user) {
      req.user = { userId: 'user-test', role: 'user' };
    }
    next();
  },
};

test('retry-wallet-funding returns error for non-custodial wallets', async () => {
  const mockDb = {
    query: async () => ({
      rows: [
        {
          id: 'user-freighter',
          email: 'freighter@test.com',
          name: 'Freighter User',
          wallet_public_key: 'G_FREIGHTER_PUB',
          wallet_type: 'freighter',
        },
      ],
    }),
  };

  const usersRoute = proxyquire('./users', {
    '../config/database': mockDb,
    '../middleware/auth': mockAuthMiddleware,
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => {},
    },
  });

  const express = require('express');
  const request = require('supertest');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { userId: 'user-freighter', role: 'user' };
    next();
  });
  app.use('/api/users', usersRoute);

  const res = await request(app).post('/api/users/retry-wallet-funding');
  assert.equal(res.status, 400);
  assert.equal(
    res.body.error,
    'Non-custodial (freighter) wallets do not require background funding'
  );
});

test('retry-wallet-funding succeeds and updates DB when stellar funding succeeds', async () => {
  let updatedDb = false;

  const mockDb = {
    query: async text => {
      if (text.includes('UPDATE users SET wallet_funded_at')) {
        updatedDb = true;
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: 'user-custodial',
            email: 'custodial@test.com',
            name: 'Custodial User',
            wallet_public_key: 'GCUSTODIAL_PUB',
            wallet_secret_encrypted: 'cpws:v1:fake',
            wallet_type: 'custodial',
          },
        ],
      };
    },
  };

  const usersRoute = proxyquire('./users', {
    '../config/database': mockDb,
    '../middleware/auth': mockAuthMiddleware,
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => 'hash123',
    },
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (secret, ctx, fn) => fn('SSECRET123'),
    },
  });

  const express = require('express');
  const request = require('supertest');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { userId: 'user-custodial', role: 'user' };
    next();
  });
  app.use('/api/users', usersRoute);

  const res = await request(app).post('/api/users/retry-wallet-funding');
  assert.equal(res.status, 200);
  assert.equal(res.body.funded, true);
  assert.equal(updatedDb, true);
});

test('retry-wallet-funding marks failure and sends email notification when funding fails', async () => {
  let failedDbUpdate = false;
  let emailSent = false;

  const mockDb = {
    query: async text => {
      if (text.includes('UPDATE users SET wallet_funding_failed_at')) {
        failedDbUpdate = true;
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: 'user-custodial-failed',
            email: 'failed@test.com',
            name: 'Failed User',
            wallet_public_key: 'GFAILED_PUB',
            wallet_secret_encrypted: 'cpws:v1:fake',
            wallet_type: 'custodial',
          },
        ],
      };
    },
  };

  const usersRoute = proxyquire('./users', {
    '../config/database': mockDb,
    '../middleware/auth': mockAuthMiddleware,
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => {
        throw new Error('Friendbot rate limit reached');
      },
    },
    '../services/walletSecrets': {
      withDecryptedWalletSecret: async (secret, ctx, fn) => fn('SSECRET123'),
    },
    '../services/emailService': {
      sendWalletFundingFailedEmail: async () => {
        emailSent = true;
      },
    },
  });

  const express = require('express');
  const request = require('supertest');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { userId: 'user-custodial-failed', role: 'user' };
    next();
  });
  app.use('/api/users', usersRoute);

  const res = await request(app).post('/api/users/retry-wallet-funding');
  assert.equal(res.status, 502);
  assert.equal(failedDbUpdate, true);
  assert.equal(emailSent, true);
});
