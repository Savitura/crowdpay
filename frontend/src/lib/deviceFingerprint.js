/**
 * Privacy-conscious device fingerprinting for fraud detection (#595).
 *
 * We deliberately collect only coarse, non-identifying signals that are already
 * exposed to any web page (screen geometry, timezone, language, a canvas hash,
 * etc.). No cookies, no persistent identifiers, no PII. The collected signals
 * are hashed in the browser with SHA-256 so only an opaque digest ever leaves
 * the device. The server salts this digest again before storing it.
 *
 * The result is cached in-memory for the page lifetime and, best-effort, in
 * sessionStorage so repeated contributions in one session reuse the same value
 * without recomputing.
 */

const CACHE_KEY = 'cp_device_fp';
let inMemoryCache = null;

function safe(fn, fallback = '') {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function canvasSignal() {
  return safe(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('CrowdPay:fp:1', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('CrowdPay:fp:1', 4, 17);
    return canvas.toDataURL();
  });
}

function collectComponents() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const scr = typeof window !== 'undefined' && window.screen ? window.screen : {};
  return [
    safe(() => nav.userAgent),
    safe(() => (Array.isArray(nav.languages) ? nav.languages.join(',') : nav.language)),
    safe(() => nav.platform),
    safe(() => String(nav.hardwareConcurrency)),
    safe(() => String(nav.deviceMemory)),
    safe(() => String(nav.maxTouchPoints)),
    safe(() => `${scr.width}x${scr.height}x${scr.colorDepth}`),
    safe(() => String(window.devicePixelRatio)),
    safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    safe(() => String(new Date().getTimezoneOffset())),
    canvasSignal(),
  ].join('||');
}

async function sha256Hex(input) {
  const cryptoObj = typeof window !== 'undefined' ? window.crypto : undefined;
  const subtle = cryptoObj && cryptoObj.subtle;
  const bytes = new window.TextEncoder().encode(input);
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback: FNV-1a expanded to a 64-hex-char string (non-secure contexts only).
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x1234;
  for (let i = 0; i < input.length; i += 1) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ input.charCodeAt(input.length - 1 - i), 0x01000193) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
    .repeat(4)
    .slice(0, 64);
}

/**
 * Returns an opaque, stable device fingerprint digest for the current browser.
 * Never throws — resolves to null if fingerprinting is unavailable.
 * @returns {Promise<string|null>}
 */
export async function getDeviceFingerprint() {
  if (inMemoryCache) return inMemoryCache;
  try {
    const cached = window.sessionStorage?.getItem(CACHE_KEY);
    if (cached && /^[a-f0-9]{16,128}$/i.test(cached)) {
      inMemoryCache = cached;
      return cached;
    }
  } catch {
    /* sessionStorage may be unavailable (private mode) — ignore */
  }

  try {
    const digest = await sha256Hex(collectComponents());
    inMemoryCache = digest;
    try {
      window.sessionStorage?.setItem(CACHE_KEY, digest);
    } catch {
      /* best-effort cache only */
    }
    return digest;
  } catch {
    return null;
  }
}
