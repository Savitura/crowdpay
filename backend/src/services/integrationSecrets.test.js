const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = './integrationSecrets';
const FAKE_SECRET = 'whsec_test_secret_key_1234567890';

test('encryptIntegrationSecret and decryptIntegrationSecret with fallback KEKs and re-encryption', async t => {
  process.env.NODE_ENV = 'test';
  process.env.INTEGRATION_SECRET_PROVIDER = 'local';

  const OLD_KEK = Buffer.alloc(32, 3).toString('base64');
  const NEW_KEK = Buffer.alloc(32, 4).toString('base64');

  // 1. Encrypt with old KEK
  process.env.INTEGRATION_SECRET_LOCAL_KEK = OLD_KEK;
  delete process.env.INTEGRATION_SECRET_LOCAL_KEK_FALLBACKS;
  delete require.cache[require.resolve(MODULE_PATH)];
  let integrationSecrets = require(MODULE_PATH);

  const encrypted = await integrationSecrets.encryptIntegrationSecret(FAKE_SECRET, {
    type: 'webhook',
    id: 'hook-1',
  });

  assert.match(encrypted, /^cpi:v1:/);
  assert.equal(integrationSecrets.isEncryptedIntegrationSecret(encrypted), true);

  // 2. Rotate to NEW_KEK with OLD_KEK in fallback
  process.env.INTEGRATION_SECRET_LOCAL_KEK = NEW_KEK;
  process.env.INTEGRATION_SECRET_LOCAL_KEK_FALLBACKS = OLD_KEK;
  delete require.cache[require.resolve(MODULE_PATH)];
  integrationSecrets = require(MODULE_PATH);

  // Fallback decrypts seamlessly
  const decrypted = await integrationSecrets.withDecryptedIntegrationSecret(
    encrypted,
    { type: 'webhook', id: 'hook-1' },
    async secret => secret
  );
  assert.equal(decrypted, FAKE_SECRET);

  assert.equal(
    await integrationSecrets.needsReencryption(encrypted, { type: 'webhook', id: 'hook-1' }),
    true
  );

  // 3. Re-encrypt with active KEK
  const reencrypted = await integrationSecrets.reencryptIntegrationSecret(encrypted, {
    type: 'webhook',
    id: 'hook-1',
  });

  assert.equal(
    await integrationSecrets.needsReencryption(reencrypted, { type: 'webhook', id: 'hook-1' }),
    false
  );

  // 4. Drop fallback KEK
  delete process.env.INTEGRATION_SECRET_LOCAL_KEK_FALLBACKS;
  delete require.cache[require.resolve(MODULE_PATH)];
  integrationSecrets = require(MODULE_PATH);

  const decryptedAfterDrop = await integrationSecrets.withDecryptedIntegrationSecret(
    reencrypted,
    { type: 'webhook', id: 'hook-1' },
    async secret => secret
  );
  assert.equal(decryptedAfterDrop, FAKE_SECRET);

  await assert.rejects(
    async () => {
      await integrationSecrets.withDecryptedIntegrationSecret(
        encrypted,
        { type: 'webhook', id: 'hook-1' },
        async secret => secret
      );
    }
  );

  t.after(() => {
    delete process.env.INTEGRATION_SECRET_PROVIDER;
    delete process.env.INTEGRATION_SECRET_LOCAL_KEK;
    delete process.env.INTEGRATION_SECRET_LOCAL_KEK_FALLBACKS;
  });
});
