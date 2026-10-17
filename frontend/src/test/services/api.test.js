import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryQueuedRequests } from '../../services/api';

const { responseRejectedHandlers, requestInterceptors } = vi.hoisted(() => ({
  responseRejectedHandlers: [],
  requestInterceptors: [],
}));

// Mock axios
vi.mock('axios', () => {
  const mockAxios = {
    create: vi.fn(() => mockAxios),
    interceptors: {
      request: { use: vi.fn((fn) => requestInterceptors.push(fn)) },
      response: { use: vi.fn((_success, failure) => responseRejectedHandlers.push(failure)) },
    },
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: mockAxios };
});

import axios from 'axios';

function setOnline(value) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => value });
}

describe('API Service - CSRF Interceptor', () => {
  let mockDocumentCookie;

  // api.js registers a single request interceptor on apiClient that echoes the
  // `cp_csrf` cookie into the `x-csrf-token` header for mutating methods (#801).
  // Drive that interceptor directly to assert its behaviour.
  function runRequestInterceptor(config) {
    expect(requestInterceptors.length).toBeGreaterThan(0);
    return requestInterceptors[0](config);
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock document.cookie
    mockDocumentCookie = '';
    Object.defineProperty(document, 'cookie', {
      get: () => mockDocumentCookie,
      set: (val) => {
        mockDocumentCookie = val;
      },
      configurable: true,
    });
  });

  it('attaches CSRF token to mutating requests when cookie exists', () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    const config = runRequestInterceptor({ method: 'post', headers: {} });

    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('does not attach CSRF token when cookie is missing', () => {
    mockDocumentCookie = '';

    const config = runRequestInterceptor({ method: 'post', headers: {} });

    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('does not attach CSRF token to GET requests', () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    const config = runRequestInterceptor({ method: 'get', headers: {} });

    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('attaches CSRF token to PUT requests', () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    const config = runRequestInterceptor({ method: 'put', headers: {} });

    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('attaches CSRF token to PATCH requests', () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    const config = runRequestInterceptor({ method: 'patch', headers: {} });

    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('attaches CSRF token to DELETE requests', () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';

    const config = runRequestInterceptor({ method: 'delete', headers: {} });

    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });
});

describe('API Service - Offline Retry Queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setOnline(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.navigator.onLine;
  });

  function rejectNetworkRequest(config = {}) {
    const error = new Error('Network Error');
    error.config = { method: 'get', url: '/campaigns', ...config };
    return responseRejectedHandlers[0](error);
  }

  it('delivers the replay response to the original GET caller', async () => {
    const originalRequest = rejectNetworkRequest();
    const response = { data: { campaigns: [] } };
    axios.request.mockResolvedValue(response);

    await retryQueuedRequests();

    await expect(originalRequest).resolves.toBe(response);
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(axios.request.mock.calls[0][0]._retried).toBe(true);
  });

  it('shares one replay for duplicate GETs and resolves each original caller', async () => {
    const firstRequest = rejectNetworkRequest();
    const secondRequest = rejectNetworkRequest();
    const response = { data: { campaigns: [] } };
    axios.request.mockResolvedValue(response);

    await retryQueuedRequests();

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([response, response]);
    expect(axios.request).toHaveBeenCalledTimes(1);
  });

  it('propagates replay failures to the original caller and drains the queue', async () => {
    const originalRequest = rejectNetworkRequest();
    axios.request.mockRejectedValue({
      response: { status: 503, data: { error: { message: 'Unavailable', code: 'DOWN' } } },
    });

    const outcomes = await retryQueuedRequests();

    await expect(originalRequest).rejects.toMatchObject({ status: 503, code: 'DOWN' });
    expect(outcomes[0].status).toBe('rejected');
    expect(await retryQueuedRequests()).toEqual([]);
  });

  it('does not queue non-GET requests', async () => {
    const error = new Error('Network Error');
    error.config = { method: 'post', url: '/campaigns' };

    await expect(responseRejectedHandlers[0](error)).rejects.toMatchObject({ status: 0 });
    await retryQueuedRequests();
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('rejects a failed GET immediately while the browser is online', async () => {
    setOnline(true);

    await expect(rejectNetworkRequest()).rejects.toMatchObject({ status: 0 });

    await retryQueuedRequests();
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('caps the queue at 100 requests and rejects an evicted caller', async () => {
    const pending = [];
    for (let index = 0; index < 101; index += 1) {
      const queued = rejectNetworkRequest({ url: `/campaigns/${index}` });
      pending.push(index === 0 ? queued.catch((error) => error) : queued);
    }
    axios.request.mockResolvedValue({ data: {} });

    await retryQueuedRequests();
    const results = await Promise.all(pending);

    expect(axios.request).toHaveBeenCalledTimes(100);
    expect(results[0]).toMatchObject({ status: 0, message: 'Network Error' });
  });
});

describe('API Service - API key management uses the cookie-session client', () => {
  let mockDocumentCookie;

  function runRequestInterceptor(config) {
    expect(requestInterceptors.length).toBeGreaterThan(0);
    return requestInterceptors[0](config);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDocumentCookie = 'cp_csrf=test-csrf-token';
    Object.defineProperty(document, 'cookie', {
      get: () => mockDocumentCookie,
      configurable: true,
    });
  });

  it('does not attach CSRF token to the API key list request (GET is safe)', () => {
    // listApiKeys() is a GET, so the interceptor never attaches the header
    // regardless of the endpoint being API-key related.
    const config = runRequestInterceptor({ method: 'get', headers: {} });

    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('attaches CSRF token to the API key create request (cookie-session POST)', () => {
    // The SPA creates API keys through the cookie-session client, so this
    // state-changing POST must echo the CSRF header. (Only genuine server-side
    // `Bearer cpk_*` requests are exempt from CSRF — see backend csrf.js.)
    const config = runRequestInterceptor({ method: 'post', headers: {} });

    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });
});
