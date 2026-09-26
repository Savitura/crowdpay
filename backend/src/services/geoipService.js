const net = require('net');
const fs = require('fs');
const logger = require('../config/logger');

/**
 * IP geolocation with pluggable providers.
 *
 * Configured entirely through environment variables (see .env.example):
 *   GEOIP_PROVIDER          none (default) | maxmind | ip-api | ipinfo
 *   GEOIP_TIMEOUT_MS        per-lookup network timeout (default 2000)
 *   GEOIP_CACHE_TTL_MS      how long a resolved IP stays cached (default 24h)
 *   GEOIP_CACHE_MAX_ENTRIES cap on cached IPs (default 5000)
 *   GEOIP_MAXMIND_DB_PATH   path to a GeoLite2-City.mmdb file (maxmind only)
 *   GEOIP_IPINFO_TOKEN      ipinfo.io API token (ipinfo only)
 *
 * Every lookup is best-effort and fails open: an unset provider, a private IP,
 * a timeout, or a provider outage all resolve to null fields rather than
 * throwing, so geolocation can never block a login.
 */

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 5000;
const MAX_FIELD_LENGTH = 100;

// After this many consecutive failures the provider is skipped entirely for
// COOLDOWN_MS, so a down or slow provider costs one timeout instead of one per
// login.
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

const EMPTY_LOCATION = Object.freeze({ country: null, region: null, city: null });

// A Map rather than an object literal: the provider name comes from the
// environment, and an object would resolve inherited keys such as
// "constructor" to a truthy value and skip the unknown-provider warning.
const PROVIDER_ALIASES = new Map([
  ['', 'none'],
  ['none', 'none'],
  ['off', 'none'],
  ['disabled', 'none'],
  ['maxmind', 'maxmind'],
  ['geolite2', 'maxmind'],
  ['ip-api', 'ip-api'],
  ['ipapi', 'ip-api'],
  ['ip-api.com', 'ip-api'],
  ['ipinfo', 'ipinfo'],
  ['ipinfo.io', 'ipinfo'],
]);

const SUPPORTED_PROVIDERS = ['none', 'maxmind', 'ip-api', 'ipinfo'];

const MAXMIND_PACKAGE_MISSING =
  "GEOIP_PROVIDER=maxmind requires the optional 'maxmind' package — install it with: npm install maxmind";

let consecutiveFailures = 0;
let cooldownUntil = 0;
let maxmindReaderPromise = null;
let maxmindReaderPath = null;
const warnedProviders = new Set();

/**
 * Resolved locations, keyed by normalized IP.
 *
 * Deliberately local and bounded rather than the shared `utils/cache`: these
 * keys come from unauthenticated login attempts, so an attacker rotating
 * source addresses controls the key space. The shared cache has no ceiling
 * and only drops expired entries when the same key is read again, which would
 * let that Map grow without limit. Map preserves insertion order, so evicting
 * the first key evicts the least recently used one.
 */
const locationCache = new Map();

/** In-flight lookups, keyed by normalized IP, so bursts collapse to one call. */
const inFlight = new Map();

function cacheGet(ip) {
  const entry = locationCache.get(ip);
  if (!entry) return undefined;

  if (Date.now() > entry.expiresAt) {
    locationCache.delete(ip);
    return undefined;
  }

  // Map iterates in insertion order, so re-inserting on read is what makes
  // eviction least-recently-used rather than oldest-first.
  locationCache.delete(ip);
  locationCache.set(ip, entry);
  return entry.location;
}

function cacheSet(ip, location, ttlMs, maxEntries) {
  locationCache.delete(ip);
  locationCache.set(ip, { location, expiresAt: Date.now() + ttlMs });

  while (locationCache.size > maxEntries) {
    const oldest = locationCache.keys().next().value;
    locationCache.delete(oldest);
  }
}

function positiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Read configuration on every lookup so env changes take effect without a
 * restart and tests can flip providers between cases.
 */
function readConfig() {
  const raw = String(process.env.GEOIP_PROVIDER || '').trim().toLowerCase();
  const provider = PROVIDER_ALIASES.get(raw);

  if (!provider && !warnedProviders.has(raw)) {
    warnedProviders.add(raw);
    logger.warn('Unknown GEOIP_PROVIDER — GeoIP lookups are disabled', {
      provider: raw,
      supported: SUPPORTED_PROVIDERS,
    });
  }

  return {
    provider: provider || 'none',
    timeoutMs: positiveInt(process.env.GEOIP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    cacheTtlMs: positiveInt(process.env.GEOIP_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    cacheMaxEntries: positiveInt(process.env.GEOIP_CACHE_MAX_ENTRIES, DEFAULT_CACHE_MAX_ENTRIES),
    maxmindDbPath: String(process.env.GEOIP_MAXMIND_DB_PATH || '').trim(),
    ipinfoToken: String(process.env.GEOIP_IPINFO_TOKEN || '').trim(),
  };
}

/**
 * Reduce an address to a bare IP literal, or null if it is not one.
 * Handles the forms Express hands back: IPv4-mapped IPv6 on dual-stack
 * sockets, bracketed IPv6, zone indexes, host:port pairs, and XFF chains.
 * @param {string} value
 * @returns {string|null}
 */
function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (!ip) return null;

  // X-Forwarded-For chain — the client is the left-most entry.
  if (ip.includes(',')) ip = ip.split(',')[0].trim();

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];

  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];

  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (withPort) ip = withPort[1];

  return net.isIP(ip) ? ip : null;
}

function isPrivateIpv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

/**
 * True only for globally routable addresses. Reserved ranges are never sent to
 * an external provider — it wastes a round trip and leaks internal topology.
 * @param {string} ip - A normalized IP literal
 * @returns {boolean}
 */
function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !isPrivateIpv4(ip);
  if (family === 6) return !isPrivateIpv6(ip);
  return false;
}

/**
 * Provider responses are untrusted input bound for TEXT columns and the
 * session UI: strip control characters, collapse whitespace, cap length.
 */
function cleanField(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- intentionally strips control chars from untrusted provider input
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_FIELD_LENGTH);
}

function toLocation({ country, region, city }) {
  return {
    country: cleanField(country),
    region: cleanField(region),
    city: cleanField(city),
  };
}

async function fetchJson(url, { timeoutMs, headers = {} }) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * ip-api.com — free tier needs no key but is HTTP-only and capped at
 * 45 requests/minute per source IP. See https://ip-api.com/docs/api:json
 */
async function lookupWithIpApi(ip, config) {
  const body = await fetchJson(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,countryCode,regionName,city`,
    { timeoutMs: config.timeoutMs }
  );

  // A `fail` status is a definitive answer from a healthy provider (unknown or
  // reserved address), not an outage — return empty rather than counting it
  // against the circuit breaker.
  if (body?.status !== 'success') {
    logger.debug('GeoIP lookup returned no result', { provider: 'ip-api', reason: body?.message });
    return EMPTY_LOCATION;
  }

  return toLocation({ country: body.countryCode, region: body.regionName, city: body.city });
}

/**
 * ipinfo.io — token sent as a bearer header rather than a query parameter so
 * it stays out of proxy and access logs.
 */
async function lookupWithIpinfo(ip, config) {
  if (!config.ipinfoToken) {
    throw new Error('GEOIP_IPINFO_TOKEN is not set');
  }

  const body = await fetchJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
    timeoutMs: config.timeoutMs,
    headers: { Authorization: `Bearer ${config.ipinfoToken}` },
  });

  // ipinfo flags reserved ranges as bogons and omits the location fields.
  if (body?.bogon) return EMPTY_LOCATION;

  return toLocation({ country: body?.country, region: body?.region, city: body?.city });
}

/**
 * Map a MaxMind GeoLite2-City record to a location.
 * @param {object|null} record - Raw record from the mmdb reader
 * @returns {{country: string|null, region: string|null, city: string|null}}
 */
function mapMaxmindRecord(record) {
  if (!record) return EMPTY_LOCATION;

  return toLocation({
    country: record.country?.iso_code || record.registered_country?.iso_code,
    region: record.subdivisions?.[0]?.names?.en,
    city: record.city?.names?.en,
  });
}

/**
 * The `maxmind` package is an optional peer: it is only required when the
 * provider is actually selected, so installs that use a hosted provider (or
 * none) do not pay for it. The opened reader is memoized per database path.
 */
function getMaxmindReader(dbPath) {
  if (maxmindReaderPromise && maxmindReaderPath === dbPath) {
    return maxmindReaderPromise;
  }

  maxmindReaderPath = dbPath;
  maxmindReaderPromise = (async () => {
    let maxmind;
    try {
      maxmind = require('maxmind');
    } catch {
      throw new Error(MAXMIND_PACKAGE_MISSING);
    }
    return maxmind.open(dbPath);
  })();

  // Allow a later lookup to retry a failed open (missing package, bad path).
  maxmindReaderPromise.catch(() => {
    maxmindReaderPromise = null;
    maxmindReaderPath = null;
  });

  return maxmindReaderPromise;
}

async function lookupWithMaxmind(ip, config) {
  if (!config.maxmindDbPath) {
    throw new Error('GEOIP_MAXMIND_DB_PATH is not set');
  }

  const reader = await getMaxmindReader(config.maxmindDbPath);
  return mapMaxmindRecord(reader.get(ip));
}

const PROVIDERS = {
  maxmind: lookupWithMaxmind,
  'ip-api': lookupWithIpApi,
  ipinfo: lookupWithIpinfo,
};

function noteFailure(provider, err) {
  consecutiveFailures += 1;

  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    consecutiveFailures = 0;
    logger.warn('GeoIP provider paused after repeated failures', {
      provider,
      cooldownMs: COOLDOWN_MS,
      error: err.message,
    });
    return;
  }

  logger.warn('GeoIP lookup failed', { provider, error: err.message });
}

/**
 * Ask the provider and cache the answer. Never rejects — callers sharing this
 * promise through `inFlight` all receive the fail-open result.
 */
async function resolveAndCache(ip, config) {
  try {
    const location = await PROVIDERS[config.provider](ip, config);
    consecutiveFailures = 0;
    cacheSet(ip, location, config.cacheTtlMs, config.cacheMaxEntries);
    return location;
  } catch (err) {
    noteFailure(config.provider, err);
    return EMPTY_LOCATION;
  }
}

/**
 * Resolve an IP address to a coarse location.
 * @param {string} rawIp - IP address, in any form Express reports
 * @returns {Promise<{country: string|null, region: string|null, city: string|null}>}
 */
function lookupIp(rawIp) {
  const config = readConfig();
  if (config.provider === 'none') return Promise.resolve(EMPTY_LOCATION);

  const ip = normalizeIp(rawIp);
  if (!ip || !isPublicIp(ip)) return Promise.resolve(EMPTY_LOCATION);

  const cached = cacheGet(ip);
  if (cached) return Promise.resolve(cached);

  if (Date.now() < cooldownUntil) return Promise.resolve(EMPTY_LOCATION);

  // Collapse concurrent lookups of the same address into a single provider
  // call — a login burst from one NAT would otherwise blow a rate limit.
  const pending = inFlight.get(ip);
  if (pending) return pending;

  const promise = resolveAndCache(ip, config).finally(() => inFlight.delete(ip));
  inFlight.set(ip, promise);
  return promise;
}

/**
 * Whether a GeoIP provider is configured.
 * @returns {boolean}
 */
function isGeoipEnabled() {
  return readConfig().provider !== 'none';
}

/**
 * Validate GeoIP configuration at startup.
 *
 * Lookups fail open by design, which means a misconfigured provider is
 * invisible at runtime — it just returns nulls forever. Failing at boot
 * instead surfaces the mistake while someone is still watching.
 *
 * @throws {Error} when a provider is selected but cannot possibly work
 */
function validateGeoipConfig() {
  const raw = String(process.env.GEOIP_PROVIDER || '').trim().toLowerCase();
  if (!PROVIDER_ALIASES.has(raw)) {
    throw new Error(
      `Unsupported GEOIP_PROVIDER: ${JSON.stringify(raw)} (supported: ${SUPPORTED_PROVIDERS.join(', ')})`
    );
  }

  for (const key of ['GEOIP_TIMEOUT_MS', 'GEOIP_CACHE_TTL_MS', 'GEOIP_CACHE_MAX_ENTRIES']) {
    const value = process.env[key];
    if (value && value.length > 0) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${key} must be a positive number (received: ${JSON.stringify(value)})`);
      }
    }
  }

  const provider = PROVIDER_ALIASES.get(raw);
  if (provider === 'none') return;

  if (provider === 'maxmind') {
    const dbPath = String(process.env.GEOIP_MAXMIND_DB_PATH || '').trim();
    if (!dbPath) {
      throw new Error('GEOIP_MAXMIND_DB_PATH is required for GEOIP_PROVIDER=maxmind');
    }
    if (!fs.existsSync(dbPath)) {
      throw new Error(`GEOIP_MAXMIND_DB_PATH does not exist: ${dbPath}`);
    }
    try {
      require('maxmind');
    } catch {
      throw new Error(MAXMIND_PACKAGE_MISSING);
    }
    return;
  }

  if (provider === 'ipinfo' && !String(process.env.GEOIP_IPINFO_TOKEN || '').trim()) {
    throw new Error('GEOIP_IPINFO_TOKEN is required for GEOIP_PROVIDER=ipinfo');
  }
}

/**
 * Drop cached lookups, the failure counter, and any open MaxMind reader.
 * Used by tests and available for operational recovery after reconfiguring.
 */
function resetGeoipState() {
  locationCache.clear();
  inFlight.clear();
  consecutiveFailures = 0;
  cooldownUntil = 0;
  maxmindReaderPromise = null;
  maxmindReaderPath = null;
  warnedProviders.clear();
}

module.exports = {
  lookupIp,
  isGeoipEnabled,
  validateGeoipConfig,
  normalizeIp,
  isPublicIp,
  mapMaxmindRecord,
  resetGeoipState,
  EMPTY_LOCATION,
  FAILURE_THRESHOLD,
  DEFAULT_CACHE_MAX_ENTRIES,
};
