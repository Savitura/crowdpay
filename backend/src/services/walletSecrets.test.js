const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = './walletSecrets';
const VALID_SECRET = 'SD4P6WLGL222ADEXEIAPJAW37RLGXOB5OEESXLQLVJFOQQIJHSEMINS3';
const VALID_SECRET_2 = 'SCFNUJWAKVOHW2MT5Q3I3NQGU3GQVE3V5GDFCXH6MBPCBY3ADLPQ6C7D';

test('encryptWalletSecret stores an envelope and decrypts back with local provider', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.WALLET_SECRET_PROVIDER = 'local';
  process.env.WALLET_SECRET_LOCAL_KEK = Buffer.alloc(32, 7).toString('base64');

  delete require.cache[require.resolve(MODULE_PATH)];
  const walletSecrets = require(MODULE_PATH);

  const encrypted = await walletSecrets.encryptWalletSecret(VALID_SECRET, {
    userId: 'user-1',
    walletPublicKey: 'GABC123',
  });

  assert.match(encrypted, /^cpws:v1:/);
  assert.notEqual(encrypted, VALID_SECRET);
  assert.equal(walletSecrets.isEncryptedWalletSecret(encrypted), true);

  const decrypted = await walletSecrets.withDecryptedWalletSecret(
    encrypted,
    { userId: 'user-1', walletPublicKey: 'GABC123' },
    async (secret) => secret
  );

  assert.equal(decrypted, VALID_SECRET);

  t.after(() => {
    delete process.env.WALLET_SECRET_PROVIDER;
    delete process.env.WALLET_SECRET_LOCAL_KEK;
  });
});

test('rotateLegacyUserWalletSecrets rewrites only plaintext rows', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.WALLET_SECRET_PROVIDER = 'local';
  process.env.WALLET_SECRET_LOCAL_KEK = Buffer.alloc(32, 9).toString('base64');

  delete require.cache[require.resolve(MODULE_PATH)];
  const walletSecrets = require(MODULE_PATH);
  const existingCiphertext = await walletSecrets.encryptWalletSecret(VALID_SECRET_2, {
    userId: 'user-2',
    walletPublicKey: 'GDEF456',
  });

  const updates = [];
  const runner = {
    async query(text, params) {
      if (text.startsWith('SELECT id, wallet_public_key')) {
        return {
          rows: [
            {
              id: 'user-1',
              wallet_public_key: 'GABC123',
              wallet_secret_encrypted: VALID_SECRET,
            },
            {
              id: 'user-2',
              wallet_public_key: 'GDEF456',
              wallet_secret_encrypted: existingCiphertext,
            },
          ],
        };
      }

      if (text.startsWith('UPDATE users SET wallet_secret_encrypted')) {
        updates.push(params);
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
  };

  const result = await walletSecrets.rotateLegacyUserWalletSecrets({ runner });
  assert.deepEqual(result, {
    total: 2,
    rotated: 1,
    alreadyEncrypted: 1,
    invalid: 0,
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1], 'user-1');
  assert.match(updates[0][0], /^cpws:v1:/);
  assert.notEqual(updates[0][0], VALID_SECRET);

  t.after(() => {
    delete process.env.WALLET_SECRET_PROVIDER;
    delete process.env.WALLET_SECRET_LOCAL_KEK;
  });
});
