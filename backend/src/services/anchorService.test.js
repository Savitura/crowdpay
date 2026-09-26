const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const PUBLIC_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

const MODULE_PATH = './anchorService';

function buildService({ configuredAssets } = {}) {
  return proxyquire(MODULE_PATH, {
    '@stellar/stellar-sdk': {
      Keypair: {},
      TransactionBuilder: {},
      WebAuth: {},
      Networks: { TESTNET: TESTNET_PASSPHRASE, PUBLIC: PUBLIC_PASSPHRASE },
    },
    '../config/stellar': {
      configuredAssets: configuredAssets || {
        USDC: { issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        XLM: { issuer: '' },
      },
    },
  });
}

const ANCHOR_ENV_KEYS = [
  'ANCHOR_MONEYGRAM_ENV',
  'STELLAR_NETWORK',
  'STELLAR_ANCHOR_DOMAIN',
  'ANCHOR_MONEYGRAM_ENABLED',
  'ANCHOR_CUSTOM_ID',
  'ANCHOR_CUSTOM_NAME',
  'ANCHOR_CUSTOM_HOME_DOMAIN',
  'ANCHOR_CUSTOM_WEB_AUTH_ENDPOINT',
  'ANCHOR_CUSTOM_SEP24_ENDPOINT',
  'ANCHOR_CUSTOM_SIGNING_KEY',
  'ANCHOR_CUSTOM_ASSET_CODE',
  'ANCHOR_CUSTOM_ASSET_ISSUER',
  'ANCHOR_CUSTOM_ENV',
  'ANCHOR_CUSTOM_NETWORK',
  'ANCHOR_CUSTOM_MARKET',
  'ANCHOR_CUSTOM_RAILS',
  'ANCHOR_CUSTOM_TESTNET',
  'ANCHOR_WALLET_HOME_DOMAIN',
  'ANCHOR_WALLET_SIGNING_SECRET',
];

function snapshotEnv() {
  const original = {};
  for (const key of ANCHOR_ENV_KEYS) {
    original[key] = process.env[key];
  }
  return original;
}

function restoreEnv(original) {
  for (const key of ANCHOR_ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

function withEnv(values, fn) {
  return async (t) => {
    const original = snapshotEnv();
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
    t.after(() => restoreEnv(original));
    return fn(t);
  };
}

test.describe('anchorService', () => {
  test.describe('moneyGramEnvironmentConfig', () => {
    test(
      'sandbox by default on testnet',
      withEnv({ STELLAR_NETWORK: 'testnet' }, async () => {
        const svc = buildService();
        const config = svc.getAnchorById('moneygram');
        assert.equal(config.id, 'moneygram');
        assert.equal(config.environment, 'sandbox');
        assert.equal(config.networkPassphrase, TESTNET_PASSPHRASE);
        assert.equal(config.webAuthEndpoint, 'https://extstellar.moneygram.com/stellaradapterservice/auth');
        assert.equal(config.sep24Endpoint, 'https://extstellar.moneygram.com/stellaradapterservice/sep24');
        assert.equal(config.assetCode, 'USDC');
      })
    );

    test(
      'production on mainnet',
      withEnv({ STELLAR_NETWORK: 'mainnet' }, async () => {
        const svc = buildService();
        const config = svc.getAnchorById('moneygram');
        assert.equal(config.environment, 'production');
        assert.equal(config.networkPassphrase, PUBLIC_PASSPHRASE);
        assert.equal(config.webAuthEndpoint, 'https://stellar.moneygram.com/stellaradapterservice/auth');
        assert.equal(config.assetIssuer, 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
      })
    );

    test(
      'explicit sandbox env wins over mainnet',
      withEnv({ STELLAR_NETWORK: 'mainnet', ANCHOR_MONEYGRAM_ENV: 'sandbox' }, async () => {
        const svc = buildService();
        const config = svc.getAnchorById('moneygram');
        assert.equal(config.environment, 'sandbox');
        assert.equal(config.networkPassphrase, TESTNET_PASSPHRASE);
      })
    );

    test(
      'preview env uses the preview endpoints',
      withEnv({ ANCHOR_MONEYGRAM_ENV: 'preview' }, async () => {
        const svc = buildService();
        const config = svc.getAnchorById('moneygram');
        assert.equal(config.environment, 'preview');
        assert.equal(config.webAuthEndpoint, 'https://previewstellar.moneygram.com/stellaradapterservicepreview/auth');
        assert.equal(config.networkPassphrase, PUBLIC_PASSPHRASE);
      })
    );

    test(
      'STELLAR_ANCHOR_DOMAIN overrides the default domain',
      withEnv({ ANCHOR_MONEYGRAM_ENV: 'sandbox', STELLAR_ANCHOR_DOMAIN: 'ramps.example.com' }, async () => {
        const svc = buildService();
        const config = svc.getAnchorById('moneygram');
        assert.match(config.webAuthEndpoint, /ramps\.example\.com/);
      })
    );
  });

  test.describe('getAvailableAnchors / getAnchorById', () => {
    test(
      'includes moneygram by default',
      withEnv({ STELLAR_NETWORK: 'testnet' }, async () => {
        const svc = buildService();
        assert.equal(svc.getAvailableAnchors().length, 1);
        assert.equal(svc.getAvailableAnchors()[0].id, 'moneygram');
      })
    );

    test(
      'excludes moneygram when disabled',
      withEnv({ STELLAR_NETWORK: 'testnet', ANCHOR_MONEYGRAM_ENABLED: 'false' }, async () => {
        const svc = buildService();
        assert.deepEqual(svc.getAvailableAnchors(), []);
        assert.equal(svc.getAnchorById('moneygram'), null);
      })
    );

    test(
      'appends a custom anchor when fully configured',
      withEnv(
        {
          STELLAR_NETWORK: 'testnet',
          ANCHOR_CUSTOM_ID: 'bank-one',
          ANCHOR_CUSTOM_NAME: 'Bank One',
          ANCHOR_CUSTOM_HOME_DOMAIN: 'anchor.bankone.com',
          ANCHOR_CUSTOM_WEB_AUTH_ENDPOINT: 'https://anchor.bankone.com/auth',
          ANCHOR_CUSTOM_SEP24_ENDPOINT: 'https://anchor.bankone.com/sep24',
          ANCHOR_CUSTOM_SIGNING_KEY: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          ANCHOR_CUSTOM_ASSET_CODE: 'USDC',
          ANCHOR_CUSTOM_ASSET_ISSUER: 'ISSUER123',
          ANCHOR_CUSTOM_RAILS: 'bank, wire ',
        },
        async () => {
          const svc = buildService();
          const anchors = svc.getAvailableAnchors();
          assert.equal(anchors.length, 2);
          const custom = anchors.find((a) => a.id === 'bank-one');
          assert.equal(custom.name, 'Bank One');
          assert.deepEqual(custom.rails, ['bank', 'wire']);
        }
      )
    );

    test(
      'custom anchor is omitted when partial config is present',
      withEnv(
        {
          ANCHOR_CUSTOM_ID: 'partial',
          ANCHOR_CUSTOM_NAME: 'Partial',
          ANCHOR_CUSTOM_HOME_DOMAIN: 'x.com',
        },
        async () => {
          const svc = buildService();
          assert.equal(svc.getAnchorById('partial'), null);
        }
      )
    );

    test('getAnchorById returns null for an unknown anchor', async () => {
      const svc = buildService();
      assert.equal(svc.getAnchorById('unknown'), null);
    });
  });

  test.describe('isAnchorConfigured / publicAnchorInfo', () => {
    test(
      'reports unavailable when the wallet domain is not configured',
      withEnv({ ANCHOR_WALLET_HOME_DOMAIN: '', ANCHOR_WALLET_SIGNING_SECRET: '' }, async () => {
        const svc = buildService();
        const anchor = svc.getAnchorById('moneygram');
        assert.equal(svc.isAnchorConfigured(anchor), false);
        assert.equal(svc.publicAnchorInfo(anchor).available, false);
        assert.equal(svc.publicAnchorInfo(anchor).interactive_protocol, 'sep24');
        assert.equal(svc.publicAnchorInfo(anchor).auth_protocol, 'sep10');
        assert.equal(svc.publicAnchorInfo(anchor).asset.code, 'USDC');
      })
    );

    test(
      'reports available when wallet domain, secret and issuer are configured',
      withEnv(
        {
          ANCHOR_WALLET_HOME_DOMAIN: 'wallet.example.com',
          ANCHOR_WALLET_SIGNING_SECRET: 'SABC123',
        },
        async () => {
          const svc = buildService();
          const anchor = svc.getAnchorById('moneygram');
          assert.equal(svc.isAnchorConfigured(anchor), true);
        }
      )
    );

    test(
      'reports unavailable when the asset issuer is missing from configured assets',
      withEnv(
        { ANCHOR_WALLET_HOME_DOMAIN: 'wallet.example.com', ANCHOR_WALLET_SIGNING_SECRET: 'SABC123' },
        async () => {
          const svc = buildService({ configuredAssets: { USDC: { issuer: '' } } });
          const anchor = Object.assign({}, svc.getAnchorById('moneygram'));
          assert.equal(svc.isAnchorConfigured(anchor), false);
        }
      )
    );
  });

  test.describe('authenticateWithAnchor', () => {
    test(
      'fails closed with 503 when wallet domain signing is not configured',
      withEnv(
        { ANCHOR_WALLET_HOME_DOMAIN: '', ANCHOR_WALLET_SIGNING_SECRET: '' },
        async () => {
          const svc = buildService();
          await assert.rejects(
            svc.authenticateWithAnchor({ anchor: svc.getAnchorById('moneygram'), userPublicKey: 'GXXX', userSecret: 'SXXX' }),
            (err) => err.statusCode === 503 && /not configured/i.test(err.message)
          );
        }
      )
    );
  });

  test.describe('status helpers', () => {
    test('isAnchorTerminalStatus / isAnchorFailureStatus classify statuses', () => {
      const svc = buildService();
      assert.equal(svc.isAnchorTerminalStatus('completed'), true);
      assert.equal(svc.isAnchorTerminalStatus('expired'), true);
      assert.equal(svc.isAnchorTerminalStatus('pending_user_transfer'), false);
      assert.equal(svc.isAnchorFailureStatus('error'), true);
      assert.equal(svc.isAnchorFailureStatus('completed'), false);
      assert.equal(svc.isAnchorFailureStatus('pending'), false);
    });
  });
});