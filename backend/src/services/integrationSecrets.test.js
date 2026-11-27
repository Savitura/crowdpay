const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const proxyquire = require('proxyquire').noCallThru();

const MODULE_PATH = './integrationSecrets';
const TEST_KEK_B64 = Buffer.alloc(32, 0x42).toString('base64');
const TEST_KEK_HEX = Buffer.alloc(32, 0x42).toString('hex');
const TEST_SECRET = 'super-secret-integration-token-xyz-12345';

function loadIntegrationSecrets({ envOverrides = {}, httpsMock } = {}) {
  const origEnv = { ...process.env };
  Object.assign(process.env, envOverrides);

  const stubs = {
    '../config/database': { query: async () => ({ rows: [] }) },
  };
  if (httpsMock) {
    stubs.https = httpsMock;
  }

  delete require.cache[require.resolve(MODULE_PATH)];
  const service = proxyquire(MODULE_PATH, stubs);

  return {
    service,
    restore() {
      process.env = origEnv;
      delete require.cache[require.resolve(MODULE_PATH)];
    },
  };
}

// ==========================================
// 1. Provider configuration & validation
// ==========================================

test('getConfiguredProvider respects INTEGRATION_SECRET_PROVIDER when set', () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: { INTEGRATION_SECRET_PROVIDER: 'custom-provider' },
  });
  try {
    assert.equal(service.getConfiguredProvider(), 'custom-provider');
  } finally {
    restore();
  }
});

test('getConfiguredProvider defaults to local in non-production environments', () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: { NODE_ENV: 'test', INTEGRATION_SECRET_PROVIDER: '' },
  });
  try {
    delete process.env.INTEGRATION_SECRET_PROVIDER;
    assert.equal(service.getConfiguredProvider(), 'local');
  } finally {
    restore();
  }
});

test('getConfiguredProvider defaults to aws-kms in production when unset', () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: { NODE_ENV: 'production', INTEGRATION_SECRET_PROVIDER: '' },
  });
  try {
    delete process.env.INTEGRATION_SECRET_PROVIDER;
    assert.equal(service.getConfiguredProvider(), 'aws-kms');
  } finally {
    restore();
  }
});

test('validateIntegrationSecretConfig rejects non-aws-kms provider in production', () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'production',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });
  try {
    assert.throws(
      () => service.validateIntegrationSecretConfig(),
      /Production requires INTEGRATION_SECRET_PROVIDER=aws-kms/
    );
  } finally {
    restore();
  }
});

test('validateIntegrationSecretConfig enforces local KEK requirements', () => {
  // Missing KEK
  const { service: s1, restore: r1 } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: '',
    },
  });
  try {
    assert.throws(
      () => s1.validateIntegrationSecretConfig(),
      /INTEGRATION_SECRET_LOCAL_KEK must be set/
    );
  } finally {
    r1();
  }

  // KEK with invalid length (16 bytes instead of 32)
  const shortKek = Buffer.alloc(16, 1).toString('base64');
  const { service: s2, restore: r2 } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: shortKek,
    },
  });
  try {
    assert.throws(() => s2.validateIntegrationSecretConfig(), /must decode to exactly 32 bytes/);
  } finally {
    r2();
  }

  // Valid 32-byte base64 KEK succeeds
  const { service: s3, restore: r3 } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });
  try {
    assert.doesNotThrow(() => s3.validateIntegrationSecretConfig());
  } finally {
    r3();
  }

  // Valid 64-character hex KEK succeeds
  const { service: s4, restore: r4 } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_HEX,
    },
  });
  try {
    assert.doesNotThrow(() => s4.validateIntegrationSecretConfig());
  } finally {
    r4();
  }
});

test('validateIntegrationSecretConfig enforces aws-kms requirements', () => {
  // Missing AWS_REGION or KMS_KEY_ID
  const { service: s1, restore: r1 } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'aws-kms',
      AWS_REGION: '',
      INTEGRATION_SECRET_KMS_KEY_ID: '',
    },
  });
  try {
    assert.throws(
      () => s1.validateIntegrationSecretConfig(),
      /AWS_REGION and INTEGRATION_SECRET_KMS_KEY_ID are required/
    );
  } finally {
    r1();
  }

  // Missing AWS credentials
  const { service: s2, restore: r2 } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'aws-kms',
      AWS_REGION: 'us-east-1',
      INTEGRATION_SECRET_KMS_KEY_ID: 'arn:aws:kms:test-key',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
    },
  });
  try {
    assert.throws(
      () => s2.validateIntegrationSecretConfig(),
      /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required/
    );
  } finally {
    r2();
  }

  // All AWS KMS vars present
  const { service: s3, restore: r3 } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'aws-kms',
      AWS_REGION: 'us-east-1',
      INTEGRATION_SECRET_KMS_KEY_ID: 'arn:aws:kms:test-key',
      AWS_ACCESS_KEY_ID: 'ASIA1234567890',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key-12345',
    },
  });
  try {
    assert.doesNotThrow(() => s3.validateIntegrationSecretConfig());
  } finally {
    r3();
  }
});

test('validateIntegrationSecretConfig rejects unsupported providers', () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'azure-key-vault',
    },
  });
  try {
    assert.throws(
      () => service.validateIntegrationSecretConfig(),
      /Unsupported INTEGRATION_SECRET_PROVIDER: azure-key-vault/
    );
  } finally {
    restore();
  }
});

// ==========================================
// 2. Encryption and Decryption (Local)
// ==========================================

test('encryptIntegrationSecret creates envelope and decrypts back to original secret', async () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });

  try {
    const encrypted = await service.encryptIntegrationSecret(TEST_SECRET, {
      type: 'github',
      id: 'repo-1',
    });

    assert.ok(encrypted.startsWith('cpi:v1:'));
    assert.notEqual(encrypted, TEST_SECRET);
    assert.equal(service.isEncryptedIntegrationSecret(encrypted), true);

    const decryptedBuffer = await service.decryptIntegrationSecretToBuffer(encrypted, {
      type: 'github',
      id: 'repo-1',
    });
    assert.equal(decryptedBuffer.toString('utf8'), TEST_SECRET);

    const result = await service.withDecryptedIntegrationSecret(
      encrypted,
      { type: 'github', id: 'repo-1' },
      async plaintext => {
        assert.equal(plaintext, TEST_SECRET);
        return 'processed-ok';
      }
    );
    assert.equal(result, 'processed-ok');
  } finally {
    restore();
  }
});

test('encryptIntegrationSecret is idempotent when secret is already encrypted', async () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });

  try {
    const encrypted = await service.encryptIntegrationSecret(TEST_SECRET);
    const reEncrypted = await service.encryptIntegrationSecret(encrypted);
    assert.equal(encrypted, reEncrypted);
  } finally {
    restore();
  }
});

test('encryptIntegrationSecret supports 64-char hex KEK', async () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_HEX,
    },
  });

  try {
    const encrypted = await service.encryptIntegrationSecret('hex-kek-secret');
    const decrypted = await service.withDecryptedIntegrationSecret(encrypted, {}, async s => s);
    assert.equal(decrypted, 'hex-kek-secret');
  } finally {
    restore();
  }
});

test('decryptIntegrationSecret enforces encryption context binding', async () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });

  try {
    const encrypted = await service.encryptIntegrationSecret(TEST_SECRET, {
      type: 'slack_webhook',
      id: 'hook-99',
    });

    // Mismatched type
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(encrypted, {
        type: 'discord_webhook',
        id: 'hook-99',
      }),
      /Integration credential context mismatch: type/
    );

    // Mismatched id
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(encrypted, {
        type: 'slack_webhook',
        id: 'hook-100',
      }),
      /Integration credential context mismatch: id/
    );

    // Matching context succeeds
    const decrypted = await service.withDecryptedIntegrationSecret(
      encrypted,
      { type: 'slack_webhook', id: 'hook-99' },
      async s => s
    );
    assert.equal(decrypted, TEST_SECRET);
  } finally {
    restore();
  }
});

// ==========================================
// 3. Rejection of missing, invalid, and malformed inputs
// ==========================================

test('decryptIntegrationSecretToBuffer rejects missing or non-string secrets', async () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });

  try {
    await assert.rejects(service.decryptIntegrationSecretToBuffer(''), /Wallet secret is missing/);
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(null),
      /Wallet secret is missing/
    );
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(undefined),
      /Wallet secret is missing/
    );
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(12345),
      /Wallet secret is missing/
    );
  } finally {
    restore();
  }
});

test('decryptIntegrationSecretToBuffer rejects plaintext or non-envelope format', async () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });

  try {
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer('plain-text-secret'),
      /Wallet secret has invalid format: encrypted envelope required/
    );

    // Envelope of different type (e.g., wallet secret or totp secret)
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer('cpws:v1:eyJ2IjoxfQ'),
      /Wallet secret has invalid format: encrypted envelope required/
    );
  } finally {
    restore();
  }
});

test('isEncryptedIntegrationSecret correctly identifies envelopes and ignores non-envelopes', () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });

  try {
    assert.equal(service.isEncryptedIntegrationSecret('plain-text'), false);
    assert.equal(service.isEncryptedIntegrationSecret(null), false);
    assert.equal(service.isEncryptedIntegrationSecret(undefined), false);
    assert.equal(service.isEncryptedIntegrationSecret('cpi:v1:not-valid-base64-json!!!'), false);

    // Unsupported kind in payload
    const invalidKindPayload = Buffer.from(JSON.stringify({ kind: 'other-kind', v: 1 })).toString(
      'base64url'
    );
    assert.equal(service.isEncryptedIntegrationSecret(`cpi:v1:${invalidKindPayload}`), false);

    // Valid envelope payload
    const validPayload = Buffer.from(
      JSON.stringify({ kind: 'integration-secret-envelope', v: 1 })
    ).toString('base64url');
    assert.equal(service.isEncryptedIntegrationSecret(`cpi:v1:${validPayload}`), true);
  } finally {
    restore();
  }
});

// ==========================================
// 4. Rejection of tampered and corrupted payloads
// ==========================================

test('decryption rejects tampered ciphertext, auth tag, IV, or wrapped key', async () => {
  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'local',
      INTEGRATION_SECRET_LOCAL_KEK: TEST_KEK_B64,
    },
  });

  try {
    const encrypted = await service.encryptIntegrationSecret(TEST_SECRET, {
      type: 'api',
      id: '1',
    });
    const prefix = 'cpi:v1:';
    const payloadStr = Buffer.from(encrypted.slice(prefix.length), 'base64url').toString('utf8');
    const baseEnvelope = JSON.parse(payloadStr);

    // Tampered sealed ciphertext
    const tamperedCiphertext = {
      ...baseEnvelope,
      ciphertext: Buffer.from('corrupted-data').toString('base64'),
    };
    const tamperedCiphertextEnv = `${prefix}${Buffer.from(JSON.stringify(tamperedCiphertext)).toString('base64url')}`;
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(tamperedCiphertextEnv, { type: 'api', id: '1' })
    );

    // Tampered auth tag (16 bytes invalid tag)
    const tamperedTag = { ...baseEnvelope, tag: crypto.randomBytes(16).toString('base64') };
    const tamperedTagEnv = `${prefix}${Buffer.from(JSON.stringify(tamperedTag)).toString('base64url')}`;
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(tamperedTagEnv, { type: 'api', id: '1' })
    );

    // Tampered IV
    const tamperedIv = { ...baseEnvelope, iv: Buffer.from('corrupted-iv!').toString('base64') };
    const tamperedIvEnv = `${prefix}${Buffer.from(JSON.stringify(tamperedIv)).toString('base64url')}`;
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(tamperedIvEnv, { type: 'api', id: '1' })
    );

    // Tampered wrapped_key
    const tamperedKey = {
      ...baseEnvelope,
      wrapped_key: Buffer.from('corrupted-key-data').toString('base64'),
    };
    const tamperedKeyEnv = `${prefix}${Buffer.from(JSON.stringify(tamperedKey)).toString('base64url')}`;
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(tamperedKeyEnv, { type: 'api', id: '1' })
    );

    // Tampered wrapped_key_tag
    const tamperedKeyTag = {
      ...baseEnvelope,
      wrapped_key_tag: Buffer.from('corrupted-key-tag').toString('base64'),
    };
    const tamperedKeyTagEnv = `${prefix}${Buffer.from(JSON.stringify(tamperedKeyTag)).toString('base64url')}`;
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(tamperedKeyTagEnv, { type: 'api', id: '1' })
    );

    // Tampered context in envelope payload (AAD mismatch)
    const tamperedContext = {
      ...baseEnvelope,
      context: { app: 'crowdpay', entity: 'integration-credential', type: 'hacked' },
    };
    const tamperedContextEnv = `${prefix}${Buffer.from(JSON.stringify(tamperedContext)).toString('base64url')}`;
    await assert.rejects(service.decryptIntegrationSecretToBuffer(tamperedContextEnv));

    // Unsupported provider in envelope
    const unsupportedProvider = { ...baseEnvelope, provider: 'unsupported-vault' };
    const unsupportedProviderEnv = `${prefix}${Buffer.from(JSON.stringify(unsupportedProvider)).toString('base64url')}`;
    await assert.rejects(
      service.decryptIntegrationSecretToBuffer(unsupportedProviderEnv, { type: 'api', id: '1' }),
      /Unsupported wallet secret provider in envelope: unsupported-vault/
    );
  } finally {
    restore();
  }
});

// ==========================================
// 5. AWS KMS provider flow and error handling
// ==========================================

test('aws-kms envelope encrypt and decrypt flow with mocked KMS', async () => {
  const generatedDataKeyPlaintext = crypto.randomBytes(32);
  const generatedCiphertextBlob = Buffer.from('encrypted-kms-data-key-blob').toString('base64');

  const capturedRequests = [];

  const mockHttps = {
    request(options, callback) {
      const emitter = new EventEmitter();
      emitter.write = chunk => {
        emitter.body = (emitter.body || '') + chunk;
      };
      emitter.end = () => {
        capturedRequests.push({ options, body: JSON.parse(emitter.body) });
        const target = options.headers['x-amz-target'];
        const res = new EventEmitter();
        res.statusCode = 200;

        process.nextTick(() => {
          callback(res);
          let responseData;
          if (target === 'TrentService.GenerateDataKey') {
            responseData = JSON.stringify({
              KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-kms-key',
              Plaintext: generatedDataKeyPlaintext.toString('base64'),
              CiphertextBlob: generatedCiphertextBlob,
            });
          } else if (target === 'TrentService.Decrypt') {
            responseData = JSON.stringify({
              KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-kms-key',
              Plaintext: generatedDataKeyPlaintext.toString('base64'),
            });
          }
          res.emit('data', Buffer.from(responseData));
          res.emit('end');
        });
      };
      return emitter;
    },
  };

  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'aws-kms',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'ASIAEXAMPLEKEYID',
      AWS_SECRET_ACCESS_KEY: 'EXAMPLESECRETKEY',
      AWS_SESSION_TOKEN: 'EXAMPLESESSIONTOKEN',
      INTEGRATION_SECRET_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/test-kms-key',
    },
    httpsMock: mockHttps,
  });

  try {
    const encrypted = await service.encryptIntegrationSecret('secret-for-kms', {
      type: 'kms-service',
      id: 'srv-1',
    });

    assert.ok(encrypted.startsWith('cpi:v1:'));
    assert.equal(capturedRequests.length, 1);
    assert.equal(
      capturedRequests[0].options.headers['x-amz-target'],
      'TrentService.GenerateDataKey'
    );
    assert.ok(capturedRequests[0].options.headers.authorization.includes('AWS4-HMAC-SHA256'));
    assert.equal(
      capturedRequests[0].options.headers['x-amz-security-token'],
      'EXAMPLESESSIONTOKEN'
    );

    const decrypted = await service.withDecryptedIntegrationSecret(
      encrypted,
      { type: 'kms-service', id: 'srv-1' },
      async plaintext => plaintext
    );

    assert.equal(decrypted, 'secret-for-kms');
    assert.equal(capturedRequests.length, 2);
    assert.equal(capturedRequests[1].options.headers['x-amz-target'], 'TrentService.Decrypt');
  } finally {
    restore();
  }
});

test('aws-kms handles KMS error responses and network errors', async () => {
  let simulatedErrorType = 'kms_failure';

  const mockHttps = {
    request(options, callback) {
      const emitter = new EventEmitter();
      emitter.write = () => {};
      emitter.end = () => {
        if (simulatedErrorType === 'network_error') {
          process.nextTick(() => {
            emitter.emit('error', new Error('KMS connection timed out'));
          });
          return;
        }

        const res = new EventEmitter();
        if (simulatedErrorType === 'non_json') {
          res.statusCode = 502;
          process.nextTick(() => {
            callback(res);
            res.emit('data', Buffer.from('<html>Bad Gateway</html>'));
            res.emit('end');
          });
          return;
        }

        res.statusCode = 400;
        process.nextTick(() => {
          callback(res);
          res.emit('data', Buffer.from(JSON.stringify({ message: 'KMS Key not found' })));
          res.emit('end');
        });
      };
      return emitter;
    },
  };

  const { service, restore } = loadIntegrationSecrets({
    envOverrides: {
      NODE_ENV: 'test',
      INTEGRATION_SECRET_PROVIDER: 'aws-kms',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'ASIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'SECRETEXAMPLE',
      INTEGRATION_SECRET_KMS_KEY_ID: 'arn:aws:kms:key-1',
    },
    httpsMock: mockHttps,
  });

  try {
    // 1. KMS HTTP error with JSON message
    simulatedErrorType = 'kms_failure';
    await assert.rejects(
      service.encryptIntegrationSecret('test-secret'),
      /KMS request failed: KMS Key not found/
    );

    // 2. KMS HTTP non-JSON error
    simulatedErrorType = 'non_json';
    await assert.rejects(
      service.encryptIntegrationSecret('test-secret'),
      /KMS returned non-JSON response \(502\)/
    );

    // 3. Network error
    simulatedErrorType = 'network_error';
    await assert.rejects(
      service.encryptIntegrationSecret('test-secret'),
      /KMS connection timed out/
    );
  } finally {
    restore();
  }
});
