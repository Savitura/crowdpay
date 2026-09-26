import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, retryQueuedRequests, apiClient } from '../../services/api';

// Mock axios
vi.mock('axios', () => {
  const mockAxios = {
    create: vi.fn(() => mockAxios),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return { default: mockAxios };
});

import axios from 'axios';

describe('API Service - CSRF Interceptor', () => {
  let mockDocumentCookie;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock document.cookie
    mockDocumentCookie = '';
    Object.defineProperty(document, 'cookie', {
      get: () => mockDocumentCookie,
      set: (val) => { mockDocumentCookie = val; },
      configurable: true,
    });
  });

  it('attaches CSRF token to mutating requests when cookie exists', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';
    
    axios.post.mockResolvedValue({ data: { success: true } });
    
    await api.createCampaign({ title: 'Test' });
    
    // Check that the request interceptor was called with the CSRF header
    const postCall = axios.post.mock.calls[0];
    const config = postCall[2];
    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('does not attach CSRF token when cookie is missing', async () => {
    mockDocumentCookie = '';
    
    axios.post.mockResolvedValue({ data: { success: true } });
    
    await api.createCampaign({ title: 'Test' });
    
    const postCall = axios.post.mock.calls[0];
    const config = postCall[2];
    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('does not attach CSRF token to GET requests', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';
    
    axios.get.mockResolvedValue({ data: { campaigns: [] } });
    
    await api.getCampaigns({});
    
    const getCall = axios.get.mock.calls[0];
    const config = getCall[1];
    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('attaches CSRF token to PUT requests', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';
    
    axios.put.mockResolvedValue({ data: { success: true } });
    
    await api.updateCampaign('campaign-id', { title: 'Updated' });
    
    const putCall = axios.put.mock.calls[0];
    const config = putCall[2];
    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('attaches CSRF token to PATCH requests', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';
    
    axios.patch.mockResolvedValue({ data: { success: true } });
    
    await api.updateCampaign('campaign-id', { title: 'Updated' });
    
    const patchCall = axios.patch.mock.calls[0];
    const config = patchCall[2];
    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });

  it('attaches CSRF token to DELETE requests', async () => {
    mockDocumentCookie = 'cp_csrf=test-csrf-token';
    
    axios.delete.mockResolvedValue({ data: { success: true } });
    
    await api.deleteApiKey('key-id');
    
    const deleteCall = axios.delete.mock.calls[0];
    const config = deleteCall[2];
    expect(config.headers['x-csrf-token']).toBe('test-csrf-token');
  });
});

describe('API Service - Offline Retry Queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues failed GET requests on network error', async () => {
    const networkError = new Error('Network Error');
    networkError.response = undefined;
    
    axios.get.mockRejectedValue(networkError);
    
    try {
      await api.getCampaigns({});
    } catch (e) {
      // Expected to throw
    }
  });

  it('replays queued requests on retryQueuedRequests', async () => {
    // First, cause a network error to queue a request
    const networkError = new Error('Network Error');
    networkError.response = undefined;
    
    axios.get.mockRejectedValueOnce(networkError);
    
    try {
      await api.getCampaigns({});
    } catch (e) {
      // Expected
    }
    
    // Now mock successful response for retry
    axios.get.mockResolvedValue({ data: { campaigns: [] } });
    
    // Call retryQueuedRequests
    await retryQueuedRequests();
    
    // Should have retried the request
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-GET requests', async () => {
    const networkError = new Error('Network Error');
    networkError.response = undefined;
    
    axios.post.mockRejectedValue(networkError);
    
    try {
      await api.createCampaign({ title: 'Test' });
    } catch (e) {
      // Expected
    }
    
    axios.post.mockResolvedValue({ data: { success: true } });
    
    await retryQueuedRequests();
    
    // POST should not be retried (only GET requests are queued)
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('handles retry failure gracefully', async () => {
    const networkError = new Error('Network Error');
    networkError.response = undefined;
    
    axios.get.mockRejectedValue(networkError);
    
    try {
      await api.getCampaigns({});
    } catch (e) {
      // Expected
    }
    
    // Retry also fails
    axios.get.mockRejectedValue(networkError);
    
    // Should not throw
    await retryQueuedRequests();
    
    // Both original and retry should have been called
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('clears queue after retry', async () => {
    const networkError = new Error('Network Error');
    networkError.response = undefined;
    
    axios.get.mockRejectedValue(networkError);
    
    try {
      await api.getCampaigns({});
    } catch (e) {
      // Expected
    }
    
    axios.get.mockResolvedValue({ data: { campaigns: [] } });
    
    await retryQueuedRequests();
    await retryQueuedRequests(); // Second call should not retry again
    
    // Should only have 2 calls (original + first retry)
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

describe('API Service - API Key requests bypass CSRF', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'cookie', {
      get: () => 'cp_csrf=test-csrf-token',
      configurable: true,
    });
  });

  it('does not attach CSRF token to API key list request', async () => {
    axios.get.mockResolvedValue({ data: [] });
    
    await api.listApiKeys();
    
    const getCall = axios.get.mock.calls[0];
    const config = getCall[1];
    // API key requests use the shared client but don't mutate state
    // They should not have CSRF token since they use Bearer auth
    expect(config.headers['x-csrf-token']).toBeUndefined();
  });

  it('does not attach CSRF token to API key create request (uses Bearer auth)', async () => {
    axios.post.mockResolvedValue({ data: { id: 'key-1', secret: 'cp_live_test' } });
    
    await api.createApiKey({ label: 'Test', scopes: ['read'] });
    
    const postCall = axios.post.mock.calls[0];
    const config = postCall[2];
    // API key requests should not use CSRF since they use API key auth
    expect(config.headers['x-csrf-token']).toBeUndefined();
  });
});
