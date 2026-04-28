const BASE = '/api';

let accessToken = null;
let refreshPromise = null;

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(method, path, body, token, options = {}) {
  const { query, _retry = false } = options;
  let url = `${BASE}${path}`;
  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    });
    url += `?${params.toString()}`;
  }

  const activeToken = token || accessToken;

  const res = await fetch(url, {
    method,
    headers: authHeaders(activeToken),
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  }

  if (res.status === 401 && !_retry && path !== '/auth/refresh' && path !== '/auth/login') {
    const promise = refresh();
    if (promise) {
      try {
        const result = await promise;
        return request(method, path, body, result.token, { ...options, _retry: true });
      } catch {
        throw new Error('Session expired. Please log in again.');
      }
    }
  }

  if (!res.ok) {
    const errorBody = data.error;
    const message =
      typeof errorBody === 'string'
        ? errorBody
        : errorBody?.message || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    if (errorBody && typeof errorBody === 'object') {
      err.code = errorBody.code;
      err.fields = errorBody.fields;
    }
    throw err;
  }

  return data;
}

async function uploadFormData(path, formData, token) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
    credentials: 'include',
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  }

  if (!res.ok) {
    const errorBody = data.error;
    const message =
      typeof errorBody === 'string'
        ? errorBody
        : errorBody?.message || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    if (errorBody && typeof errorBody === 'object') {
      err.code = errorBody.code;
      err.fields = errorBody.fields;
    }
    throw err;
  }

  return data;
}

async function refresh() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!res.ok) {
      const text = await res.text();
      let error = 'Refresh failed';
      try {
        const data = JSON.parse(text);
        error = data.error || error;
      } catch {}
      refreshPromise = null;
      throw new Error(error);
    }

    const data = await res.json();
    accessToken = data.token;
    refreshPromise = null;
    return data;
  })();

  return refreshPromise;
}

async function logout() {
  const res = await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!res.ok) {
    const text = await res.text();
    let error = 'Logout failed';
    try {
      const data = JSON.parse(text);
      error = data.error || error;
    } catch {}
    throw new Error(error);
  }

  accessToken = null;
  return { message: 'Logged out' };
}

function setToken(t) {
  accessToken = t;
}

export const api = {
  register: (body) => request('POST', '/auth/register', body),
  login: (body) => request('POST', '/auth/login', body),
  logout: () => logout(),
  refresh,
  setToken,
  getToken: () => accessToken,

  getMyCampaigns: (token) => request('GET', '/users/me/campaigns', null, token),
  getMyStats: (token) => request('GET', '/users/me/stats', null, token),
  getMyContributions: (token) => request('GET', '/users/me/contributions', null, token),
  getMe: (token) => request('GET', '/users/me', null, token),
  startKyc: (token) => request('POST', '/users/me/kyc/start', null, token),

  getCampaigns: (options = {}) => request('GET', '/campaigns', null, null, { query: options }),
  getCampaign: (id) => request('GET', `/campaigns/${id}`),
  getCampaignBalance: (id) => request('GET', `/campaigns/${id}/balance`),
  createCampaign: (body, token) => request('POST', '/campaigns', body, token),
  uploadCampaignCoverImage: (campaignId, file, token) => {
    const formData = new FormData();
    formData.append('cover_image', file);
    return uploadFormData(`/campaigns/${encodeURIComponent(campaignId)}/cover-image`, formData, token);
  },
  getAnchorInfo: () => request('GET', '/anchor/info'),
  startAnchorDeposit: (body, token) => request('POST', '/anchor/deposits/start', body, token),
  getAnchorDepositStatus: (id, token) => request('GET', `/anchor/deposits/${id}`, null, token),
  getCampaignUpdates: (campaignId, options = {}) =>
    request('GET', `/campaigns/${campaignId}/updates`, null, null, { query: options }),
  postCampaignUpdate: (campaignId, body, token) =>
    request('POST', `/campaigns/${campaignId}/updates`, body, token),

  getContributions: (campaignId) => request('GET', `/contributions/campaign/${campaignId}`),
  getMilestones: (campaignId) => request('GET', `/milestones/campaign/${campaignId}`),
  submitMilestoneEvidence: (id, body, token) => request('POST', `/milestones/${id}/submit`, body, token),
  approveMilestone: (id, body, token) => request('POST', `/milestones/${id}/approve`, body || {}, token),
  rejectMilestone: (id, body, token) => request('POST', `/milestones/${id}/reject`, body || {}, token),
  contribute: (body, token) => request('POST', '/contributions', body, token),
  prepareContribution: (body, token) => request('POST', '/contributions/prepare', body, token),
  submitSignedContribution: (body, token) => request('POST', '/contributions/submit-signed', body, token),
  quoteContribution: ({ send_asset, dest_asset, dest_amount }, token) =>
    request('GET', '/contributions/quote', null, token, {
      query: { send_asset, dest_asset, dest_amount },
    }),
  failExpiredCampaigns: (token) => request('POST', '/campaigns/cron/fail-expired', null, token),
  triggerCampaignRefunds: (campaignId, token) => request('POST', `/campaigns/${campaignId}/trigger-refunds`, null, token),

  getWithdrawalCapabilities: (token) => request('GET', '/withdrawals/capabilities', null, token),
  listWithdrawals: (campaignId, token) =>
    request('GET', `/withdrawals/campaign/${campaignId}`, null, token),
  requestWithdrawal: (body, token) => request('POST', '/withdrawals/request', body, token),
  approveWithdrawalCreator: (id, token) =>
    request('POST', `/withdrawals/${id}/approve/creator`, {}, token),
  approveWithdrawalPlatform: (id, token) =>
    request('POST', `/withdrawals/${id}/approve/platform`, {}, token),
  cancelWithdrawal: (id, body, token) => request('POST', `/withdrawals/${id}/cancel`, body || {}, token),
  rejectWithdrawal: (id, body, token) => request('POST', `/withdrawals/${id}/reject`, body || {}, token),
  getWithdrawalEvents: (id, token) => request('GET', `/withdrawals/${id}/events`, null, token),

  getAdminStats: (token) => request('GET', '/admin/stats', null, token),
  getAdminCampaigns: (token) => request('GET', '/admin/campaigns', null, token),
  getAdminMilestones: (token, options = {}) => request('GET', '/admin/milestones', null, token, { query: options }),
  getAdminUsers: (token) => request('GET', '/admin/users', null, token),
  updateCampaignStatus: (id, status, token) => request('PATCH', `/admin/campaigns/${id}/status`, { status }, token),
  listApiKeys: (token) => request('GET', '/api-keys', null, token),
  createApiKey: (body, token) => request('POST', '/api-keys', body, token),
  deleteApiKey: (id, token) => request('DELETE', `/api-keys/${id}`, null, token),

  listWebhooks: (token) => request('GET', '/webhooks', null, token),
  createWebhook: (body, token) => request('POST', '/webhooks', body, token),
  deleteWebhook: (id, token) => request('DELETE', `/webhooks/${id}`, null, token),
  listWebhookDeliveries: (token, options = {}) =>
    request('GET', '/webhooks/deliveries', null, token, { query: options }),
};
