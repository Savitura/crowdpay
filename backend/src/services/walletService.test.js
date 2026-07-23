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

test('encryptSecret produces an iv:authTag:ciphertext envelope that decryptSecret reverses', (t) => {
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

test('decryptSecret throws when the ciphertext or auth tag has been tampered with', (t) => {
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

test('decryptSecret throws on malformed input missing the expected iv:authTag:ciphertext parts', (t) => {
  const walletService = freshWalletService(FAKE_KEY_HEX);

  assert.throws(() => walletService.decryptSecret('not-encrypted-data'));
  assert.throws(() => walletService.decryptSecret(''));

  t.after(() => {
    delete process.env.WALLET_ENCRYPTION_KEY;
  });
});
