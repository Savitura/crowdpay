'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { resolveSafeConnectTarget } = require('./ssrfGuard');

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 9000;

class SsrfBlockedError extends Error {
  constructor(reason) {
    super(`SSRF guard: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.isSsrfBlocked = true;
  }
}

/**
 * Build the custom lookup used by the pinned request.
 *
 * Node calls a custom `lookup` in one of two shapes: when happy-eyeballs /
 * auto-family-selection is active (the default from Node 20 onwards) it passes
 * `{ all: true }` and expects an array of address records; otherwise it expects
 * a single `(address, family)` pair. Returning the wrong shape makes Node throw
 * `ERR_INVALID_IP_ADDRESS` instead of connecting, so the pin never takes effect.
 * Honouring both shapes keeps the socket bound to the address that was
 * validated by `resolveSafeConnectTarget`.
 *
 * @param {string} address validated IPv4/IPv6 address to connect to
 * @param {number|string} family address family (4 or 6)
 * @returns {(hostname: string, options: object, callback: Function) => void}
 */
function pinnedLookup(address, family) {
  const pinnedFamily = Number(family) || 4;
  return (_hostname, options, callback) => {
    if (options && options.all) {
      callback(null, [{ address, family: pinnedFamily }]);
      return;
    }
    callback(null, address, pinnedFamily);
  };
}

/**
 * Issues a single HTTP(S) request pinned to `resolved.pinnedAddress` — the
 * connection is opened to that address regardless of what the hostname
 * resolves to at socket-open time, closing the DNS-rebinding window between
 * validation and connection. The original hostname is still sent as the
 * `Host` header and, for HTTPS, as the TLS SNI/servername, so routing and
 * certificate verification behave exactly as they would for a normal request.
 */
function performPinnedRequest(urlString, resolved, { method, headers, body, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(urlString);
    const isHttps = u.protocol === 'https:';
    const transport = isHttps ? https : http;

    const requestOptions = {
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { ...headers, Host: u.host },
      timeout: timeoutMs,
      lookup: pinnedLookup(resolved.pinnedAddress, resolved.family || 4),
    };
    if (isHttps) {
      requestOptions.servername = u.hostname;
    }

    const req = transport.request(requestOptions, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePromise({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: res.headers,
          text: async () => text,
        });
      });
      res.on('error', reject);
    });

    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

/**
 * SSRF-safe fetch for outbound webhook delivery. Validates and pins the
 * connection target on every hop (including redirects) through the same
 * `resolveSafeConnectTarget` check, so:
 *  - every resolved A/AAAA record is checked, not just the first,
 *  - the address actually connected to is the one that was validated
 *    (no separate re-resolution a DNS-rebinding attacker could race), and
 *  - a redirect to a private/internal target is rejected exactly like the
 *    original URL would be, instead of being followed automatically.
 *
 * Returns a minimal fetch-like response: `{ status, ok, headers, text() }`.
 */
async function safeFetch(urlString, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = options;

  let currentUrl = urlString;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await resolveSafeConnectTarget(currentUrl);
    if (!resolved.safe) {
      throw new SsrfBlockedError(resolved.reason);
    }

    const response = await performPinnedRequest(currentUrl, resolved, {
      method,
      headers,
      body,
      timeoutMs,
    });

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      currentUrl = new URL(response.headers.location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new SsrfBlockedError(`too many redirects (max ${maxRedirects})`);
}

module.exports = { safeFetch, SsrfBlockedError, pinnedLookup };
