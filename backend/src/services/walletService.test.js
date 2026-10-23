const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = './walletService';
// Fake 32-byte key expressed as hex — not a production key, generated for tests only.
const FAKE_KEY_HEX = 'a1'.repeat(32);
const FAKE_SECRET = 'this-is-a-fake-test-wallet-secret';

function freshWalletService(keyHex) {
  process.env.WALLET_ENCRYPTION_KEY = keyHex;
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

test('encryptSecret produces an iv:authTag:ciphertext envelope that decryptSecret reverses', t => {
  const walletService = freshWalletService(FAKE_KEY_HEX);

  const encrypted = walletService.encryptSecret(FAKE_SECRET);

  const parts = encrypted.split(':');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^[0-9a-f]{32}$/); // 16-byte IV
  assert.match(parts[1], /^[0-9a-f]{32}$/); // 16-byte GCM auth tag
  assert.notEqual(encrypted, FAKE_SECRET);

  const decrypted = walletService.decryptSecret(encrypted);
  assert.equal(decrypted, FAKE_SECRET);

  t.after(() => {
    delete process.env.WALLET_ENCRYPTION_KEY;
  });
});

test('decryptSecret throws when the ciphertext or auth tag has been tampered with', t => {
  const walletService = freshWalletService(FAKE_KEY_HEX);

  const encrypted = walletService.encryptSecret(FAKE_SECRET);
  const [ivHex, authTagHex, cipherHex] = encrypted.split(':');

  // Flip one hex character in the ciphertext to simulate tampering.
  const flippedChar = cipherHex[0] === '0' ? '1' : '0';
  const tamperedCipher = flippedChar + cipherHex.slice(1);
  const tamperedCiphertext = `${ivHex}:${authTagHex}:${tamperedCipher}`;

  assert.throws(() => walletService.decryptSecret(tamperedCiphertext));

  // Flip one hex character in the auth tag itself.
  const flippedTagChar = authTagHex[0] === '0' ? '1' : '0';
  const tamperedTag = flippedTagChar + authTagHex.slice(1);
  const tamperedAuthTag = `${ivHex}:${tamperedTag}:${cipherHex}`;

  assert.throws(() => walletService.decryptSecret(tamperedAuthTag));

  t.after(() => {
    delete process.env.WALLET_ENCRYPTION_KEY;
  });
});

test('decryptSecret throws on malformed input missing the expected iv:authTag:ciphertext parts', t => {
  const walletService = freshWalletService(FAKE_KEY_HEX);

  assert.throws(() => walletService.decryptSecret('not-encrypted-data'));
  assert.throws(() => walletService.decryptSecret(''));

  t.after(() => {
    delete process.env.WALLET_ENCRYPTION_KEY;
  });
});

test('validateWalletEncryptionKey throws when WALLET_ENCRYPTION_KEY is missing or invalid', t => {
  delete process.env.WALLET_ENCRYPTION_KEY;
  delete require.cache[require.resolve(MODULE_PATH)];
  const walletService = require(MODULE_PATH);

  assert.throws(() => walletService.validateWalletEncryptionKey(), {
    message: 'WALLET_ENCRYPTION_KEY must be set for wallet encryption',
  });

  process.env.WALLET_ENCRYPTION_KEY = 'not-a-valid-key';
  delete require.cache[require.resolve(MODULE_PATH)];
  const walletServiceInvalid = require(MODULE_PATH);

  assert.throws(() => walletServiceInvalid.validateWalletEncryptionKey(), {
    message: 'WALLET_ENCRYPTION_KEY must be base64 or hex encoded',
  });

  process.env.WALLET_ENCRYPTION_KEY = FAKE_KEY_HEX;
  process.env.WALLET_ENCRYPTION_KEY_FALLBACKS = 'not-valid-fallback';
  delete require.cache[require.resolve(MODULE_PATH)];
  const walletServiceInvalidFallback = require(MODULE_PATH);

  assert.throws(() => walletServiceInvalidFallback.validateWalletEncryptionKey(), {
    message: 'WALLET_ENCRYPTION_KEY_FALLBACKS[0] must be base64 or hex encoded',
  });

  t.after(() => {
    delete process.env.WALLET_ENCRYPTION_KEY;
    delete process.env.WALLET_ENCRYPTION_KEY_FALLBACKS;
  });
});

test('decryptSecret supports versioned enc:v1 envelopes and re-encrypts correctly', t => {
  const walletService = freshWalletService(FAKE_KEY_HEX);

  const versionedEncrypted = walletService.encryptSecret(FAKE_SECRET, { version: 1 });
  assert.match(versionedEncrypted, /^enc:v1:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/i);

  const decrypted = walletService.decryptSecret(versionedEncrypted);
  assert.equal(decrypted, FAKE_SECRET);

  assert.equal(walletService.needsReencryption(versionedEncrypted, 1), false);
  assert.equal(walletService.needsReencryption(versionedEncrypted, 2), true);

  t.after(() => {
    delete process.env.WALLET_ENCRYPTION_KEY;
  });
});

test('zero-downtime rotation: secrets encrypted under previous key decrypt seamlessly via fallback keys', t => {
  const OLD_KEY_HEX = '11'.repeat(32);
  const NEW_KEY_HEX = '22'.repeat(32);

  // 1. Encrypt under old key (legacy envelope and versioned envelope)
  process.env.WALLET_ENCRYPTION_KEY = OLD_KEY_HEX;
  delete process.env.WALLET_ENCRYPTION_KEY_FALLBACKS;
  delete require.cache[require.resolve(MODULE_PATH)];
  let walletService = require(MODULE_PATH);

  const legacyEncrypted = walletService.encryptSecret(FAKE_SECRET, { version: null });
  const versionedEncrypted = walletService.encryptSecret(FAKE_SECRET, { version: 1 });

  // 2. Rotate key without downtime: NEW_KEY is active, OLD_KEY is in fallbacks
  process.env.WALLET_ENCRYPTION_KEY = NEW_KEY_HEX;
  process.env.WALLET_ENCRYPTION_KEY_FALLBACKS = OLD_KEY_HEX;
  delete require.cache[require.resolve(MODULE_PATH)];
  walletService = require(MODULE_PATH);

  // Both should decrypt cleanly using the fallback key
  assert.equal(walletService.decryptSecret(legacyEncrypted), FAKE_SECRET);
  assert.equal(walletService.decryptSecret(versionedEncrypted), FAKE_SECRET);

  // Needs reencryption because active key differs
  assert.equal(walletService.needsReencryption(legacyEncrypted), true);
  assert.equal(walletService.needsReencryption(versionedEncrypted), true);

  // 3. Re-encrypt with active key
  const reencrypted = walletService.reencryptSecret(versionedEncrypted);
  assert.equal(walletService.decryptSecret(reencrypted), FAKE_SECRET);
  assert.equal(walletService.needsReencryption(reencrypted), false);

  // 4. Now remove OLD_KEY from fallbacks: reencrypted secret still works
  delete process.env.WALLET_ENCRYPTION_KEY_FALLBACKS;
  delete require.cache[require.resolve(MODULE_PATH)];
  walletService = require(MODULE_PATH);

  assert.equal(walletService.decryptSecret(reencrypted), FAKE_SECRET);

  // The un-reencrypted ones should now fail to decrypt since old key was phased out
  assert.throws(() => walletService.decryptSecret(legacyEncrypted));

  t.after(() => {
    delete process.env.WALLET_ENCRYPTION_KEY;
    delete process.env.WALLET_ENCRYPTION_KEY_FALLBACKS;
  });
});

