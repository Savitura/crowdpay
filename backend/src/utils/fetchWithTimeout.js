'use strict';

const DEFAULT_TIMEOUT_MS = 10_000;

class TimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

/**
 * Fetch wrapper that applies a bounded timeout via AbortSignal.timeout.
 *
 * @param {string|URL} url
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...fetchOptions } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: combinedSignal,
    });
  } catch (err) {
    if (timeoutSignal.aborted && (!callerSignal || !callerSignal.aborted)) {
      const targetUrl = typeof url === 'string' ? url : url?.href || 'URL';
      const timeoutError = new TimeoutError(
        `Request to ${targetUrl} timed out after ${timeoutMs}ms`
      );
      timeoutError.cause = err;
      throw timeoutError;
    }
    throw err;
  }
}

module.exports = {
  fetchWithTimeout,
  TimeoutError,
  DEFAULT_TIMEOUT_MS,
};
