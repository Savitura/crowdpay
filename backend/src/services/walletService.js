const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const CURRENT_KEY_VERSION = 1;
const VERSIONED_ENVELOPE_REGEX = /^enc:v(\d+):([0-9a-fA-F]+):([0-9a-fA-F]+):([0-9a-fA-F]+)$/;
const LEGACY_ENVELOPE_REGEX = /^([0-9a-fA-F]+):([0-9a-fA-F]+):([0-9a-fA-F]+)$/;

let KEY_CACHE;

function decodeKeyMaterial(value, envVarName = 'WALLET_ENCRYPTION_KEY') {
  const input = String(value || '').trim();
  if (!input) {
    throw new Error(`${envVarName} must be set for wallet encryption`);
  }

  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return Buffer.from(input, 'hex');
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    return Buffer.from(input, 'base64');
  }

  throw new Error(`${envVarName} must be base64 or hex encoded`);
}

function parseFallbackKeys(rawValue) {
  if (!rawValue) return [];
  const entries = String(rawValue)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const keys = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const key = decodeKeyMaterial(entry, `WALLET_ENCRYPTION_KEY_FALLBACKS[${i}]`);
    if (key.length !== 32) {
      throw new Error(`WALLET_ENCRYPTION_KEY_FALLBACKS[${i}] must decode to exactly 32 bytes`);
    }
    keys.push(key);
  }
  return keys;
}

function getActiveKey() {
  const key = decodeKeyMaterial(process.env.WALLET_ENCRYPTION_KEY);
  if (key.length !== 32) {
    throw new Error('WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

function getKeyRing() {
  const activeKey = getActiveKey();
  const rawFallbacks = process.env.WALLET_ENCRYPTION_KEY_FALLBACKS;
  const fallbackKeys = parseFallbackKeys(rawFallbacks);
  return {
    activeKey,
    allKeys: [activeKey, ...fallbackKeys],
  };
}

function getKey() {
  if (KEY_CACHE) return KEY_CACHE;
  const key = getActiveKey();
  KEY_CACHE = key;
  return key;
}

function validateWalletEncryptionKey() {
  // Validates active key and any fallbacks configured
  getKeyRing();
}

function encryptSecret(secret, { version = null } = {}) {
  const key = getActiveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  if (version !== undefined && version !== null) {
    return `enc:v${version}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function parseEncryptedData(encryptedData) {
  if (typeof encryptedData !== 'string' || !encryptedData) {
    throw new Error('Invalid encrypted data format');
  }

  const versionedMatch = encryptedData.match(VERSIONED_ENVELOPE_REGEX);
  if (versionedMatch) {
    return {
      version: parseInt(versionedMatch[1], 10),
      ivHex: versionedMatch[2],
      authTagHex: versionedMatch[3],
      encryptedHex: versionedMatch[4],
      isVersioned: true,
    };
  }

  const legacyMatch = encryptedData.match(LEGACY_ENVELOPE_REGEX);
  if (legacyMatch) {
    return {
      version: 0,
      ivHex: legacyMatch[1],
      authTagHex: legacyMatch[2],
      encryptedHex: legacyMatch[3],
      isVersioned: false,
    };
  }

  throw new Error('Invalid encrypted data format');
}

function decryptWithKey(key, ivHex, authTagHex, encryptedHex) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return decipher.update(Buffer.from(encryptedHex, 'hex'), null, 'utf8') + decipher.final('utf8');
}

function decryptSecret(encryptedData) {
  const parsed = parseEncryptedData(encryptedData);
  const { allKeys } = getKeyRing();

  let lastError;
  for (const key of allKeys) {
    try {
      return decryptWithKey(key, parsed.ivHex, parsed.authTagHex, parsed.encryptedHex);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to decrypt secret with available keys');
}

function needsReencryption(encryptedData, targetVersion = CURRENT_KEY_VERSION) {
  try {
    const parsed = parseEncryptedData(encryptedData);
    if (!parsed.isVersioned || parsed.version !== targetVersion) {
      return true;
    }

    // Even if version matches, verify if it decrypts with the active key directly.
    // If it only decrypts with a fallback key, it needs re-encryption with the active key.
    const activeKey = getActiveKey();
    try {
      decryptWithKey(activeKey, parsed.ivHex, parsed.authTagHex, parsed.encryptedHex);
      return false;
    } catch (_err) {
      return true;
    }
  } catch (_err) {
    return false;
  }
}

function reencryptSecret(encryptedData, { targetVersion = CURRENT_KEY_VERSION } = {}) {
  const plaintext = decryptSecret(encryptedData);
  return encryptSecret(plaintext, { version: targetVersion });
}

module.exports = {
  CURRENT_KEY_VERSION,
  encryptSecret,
  decryptSecret,
  getKey,
  validateWalletEncryptionKey,
  needsReencryption,
  reencryptSecret,
  parseEncryptedData,
};

