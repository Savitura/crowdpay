const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE = `${API_BASE_URL}/api`;
let refreshPromise = null;
const retryQueue = [];

const IDEMPOTENT_METHODS = new Set(['GET']);

function isNetworkError(err) {
  return err instanceof TypeError;
}

export function retryQueuedRequests() {
  const queue = [...retryQueue];
  retryQueue.length = 0;
  for (const item of queue) {
    const { method, path, body, options, resolve, reject } = item;
    request(method, path, body, options)
      .then(resolve)
      .catch((err) => {
        if (isNetworkError(err)) {
          retryQueue.push(item);
        } else {
          reject(err);
        }
      });
  }
}

const TIMEOUTS = {
  GET: 10_000, // 10 s
  POST: 20_000, // 20 s — Stellar submissions can be slow
  PATCH: 15_000,
  DELETE: 10_000,
};

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
  };
}

async function request(method, path, body, options = {}) {
  const { query, _retry = false } = options || {};
  let url = `${BASE}${path}`;

  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    });
    url += `?${params.toString()}`;
  }

  const controller = new AbortController();
  const timeoutMs = TIMEOUTS[method] ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? jsonHeaders() : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    if (isNetworkError(err)) {
      if (IDEMPOTENT_METHODS.has(method)) {
        return new Promise((resolve, reject) => {
          retryQueue.push({ method, path, body, options, resolve, reject });
        });
      }
      throw new Error('You appear to be offline. Please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  }

  const publicAuthPaths = [
    '/auth/refresh',
    '/auth/login',
    '/auth/forgot-password',
    '/auth/reset-password',
  ];

  if (res.status === 401 && !_retry && !publicAuthPaths.includes(path)) {
    const promise = refresh();
    if (promise) {
      try {
        await promise;
        return request(method, path, body, { ...options, _retry: true });
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

async function uploadFormData(path, formData) {
  const url = `${BASE}${path}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });
  } catch (err) {
    if (isNetworkError(err)) {
      throw new Error('You appear to be offline. Please check your connection and try again.');
    }
    throw err;
  }

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
      } catch (_err) {
        // ignore
      }
      refreshPromise = null;
      throw new Error(error);
    }

    const data = await res.json();
    refreshPromise = null;
    return data;
  })();

  return refreshPromise;
}

function parseDownloadFilename(disposition, fallback) {
  if (!disposition) return fallback;

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].replace(/^"|"$/g, '') || fallback;
    }
  }

  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

async function downloadFile(path, fallbackFilename, options = {}) {
  const { _retry = false } = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Download timed out. Check your connection and try again.');
    }
    if (isNetworkError(err)) {
      throw new Error('You appear to be offline. Please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 && !_retry) {
    try {
      await refresh();
      return downloadFile(path, fallbackFilename, { _retry: true });
    } catch {
      throw new Error('Session expired. Please log in again.');
    }
  }

  if (!res.ok) {
    const text = await res.text();
    let message = `Download failed (${res.status})`;
    try {
      const data = JSON.parse(text);
      const errorBody = data.error;
      message = typeof errorBody === 'string' ? errorBody : errorBody?.message || message;
    } catch {
      if (text) message = text;
    }

    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return {
    blob: await res.blob(),
    filename: parseDownloadFilename(res.headers.get('content-disposition'), fallbackFilename),
  };
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
    } catch (_err) {
      /* ignore */
    }
    throw new Error(error);
  }

  return { message: 'Logged out' };
}

export const api = {
  getPlatformConfig: () => request('GET', '/config'),

  register: (body) => request('POST', '/auth/register', body),
  login: (body) => request('POST', '/auth/login', body),
  login2FA: (body) => request('POST', '/auth/2fa/challenge', body),
  setup2FA: () => request('POST', '/auth/2fa/setup'),
  verify2FA: (body) => request('POST', '/auth/2fa/verify', body),
  forgotPassword: (body) => request('POST', '/auth/forgot-password', body),
  resetPassword: (body) => request('POST', '/auth/reset-password', body),
  logout: () => logout(),
  refresh,

  getMe: () => request('GET', '/users/me'),
  getMyBalance: () => request('GET', '/users/me/balance'),
  getMyStats: () => request('GET', '/users/me/stats'),
  getMyContributions: () => request('GET', '/contributions/mine'),
  startKyc: () => request('POST', '/auth/kyc/start'),
  getKycStatus: () => request('GET', '/auth/kyc/status'),

  getMyCampaigns: () => request('GET', '/campaigns/mine'),
  getFeaturedCampaigns: () => request('GET', '/campaigns/featured'),
  getCampaigns: (options = {}) => request('GET', '/campaigns', null, { query: options }),
  getCampaign: (id, options = {}) => request('GET', `/campaigns/${id}`, null, { query: options }),
  getCampaignAnalytics: (id) => request('GET', `/campaigns/${id}/analytics`),
  getCampaignAnalyticsContributors: (id) =>
    request('GET', `/campaigns/${id}/analytics/contributors`),
  exportCampaignContributions: (id) =>
    downloadFile(
      `/campaigns/${encodeURIComponent(id)}/contributions/export`,
      `campaign-${id}-contributors.csv`
    ),
  getUserDashboardAnalytics: () => request('GET', '/users/me/dashboard/analytics'),
  getCampaignEmbed: (id) => request('GET', `/campaigns/${id}/embed`),
  getCampaignBackers: (id) => request('GET', `/campaigns/${id}/backers`),
  getCampaignBalance: (id) => request('GET', `/campaigns/${id}/balance`),
  getCloneData: (id) => request('GET', `/campaigns/${id}/clone-data`),
  createCampaign: (body) => request('POST', '/campaigns', body),
  updateCampaign: (id, body) => request('PATCH', `/campaigns/${id}`, body),
  deleteCampaign: (id) => request('DELETE', `/campaigns/${id}`),
  uploadCampaignCoverImage: (campaignId, file) => {
    const formData = new FormData();
    formData.append('cover_image', file);
    return uploadFormData(`/campaigns/${encodeURIComponent(campaignId)}/cover-image`, formData);
  },

  getCampaignMembers: (campaignId) => request('GET', `/campaigns/${campaignId}/members`),
  inviteCampaignMember: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/members/invite`, body),
  resendCampaignInvite: (campaignId, memberId) =>
    request('POST', `/campaigns/${campaignId}/members/${memberId}/resend`),
  cancelCampaignInvite: (campaignId, memberId) =>
    request('DELETE', `/campaigns/${campaignId}/members/invites/${memberId}`),
  getInvitePreview: (token) => request('GET', `/invites/${token}`),
  acceptInviteByToken: (token) => request('POST', `/invites/${token}/accept`, {}),
  updateCampaignMemberRole: (campaignId, userId, body) =>
    request('PATCH', `/campaigns/${campaignId}/members/${userId}`, body),
  removeCampaignMember: (campaignId, userId) =>
    request('DELETE', `/campaigns/${campaignId}/members/${userId}`),
  acceptCampaignInvitation: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/members/accept`, body),
  getAnchorInfo: () => request('GET', '/anchor/info'),
  startAnchorDeposit: (body) => request('POST', '/anchor/deposits/start', body),
  getAnchorDepositStatus: (id) => request('GET', `/anchor/deposits/${id}`),
  getSep24Assets: () => request('GET', '/anchor/sep24/assets'),
  startWalletDeposit: (body) => request('POST', '/anchor/sep24/deposit', body),
  getCampaignUpdates: (campaignId, options = {}) =>
    request('GET', `/campaigns/${campaignId}/updates`, null, {
      query: options,
    }),
  postCampaignUpdate: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/updates`, body),
  updateCampaignUpdate: (campaignId, updateId, body) =>
    request('PATCH', `/campaigns/${campaignId}/updates/${updateId}`, body),
  deleteCampaignUpdate: (campaignId, updateId) =>
    request('DELETE', `/campaigns/${campaignId}/updates/${updateId}`),

  getContributions: (campaignId, options = {}) =>
    request('GET', `/contributions/campaign/${campaignId}`, null, {
      query: options,
    }),
  toggleCampaignVisibility: (id, is_hidden) =>
    request('PATCH', `/campaigns/${id}/visibility`, { is_hidden }),

  getMilestones: (campaignId) => request('GET', `/campaigns/${campaignId}/milestones`),
  setCampaignMilestones: (campaignId, milestones) =>
    request('POST', `/campaigns/${campaignId}/milestones`, { milestones }),
  submitMilestoneEvidence: (id, body) => request('POST', `/milestones/${id}/submit`, body),
  uploadMilestoneEvidence: (id, file) => {
    const formData = new FormData();
    formData.append('evidence_file', file);
    return uploadFormData(`/milestones/${encodeURIComponent(id)}/upload-evidence`, formData);
  },
  getMilestoneEvents: (id) => request('GET', `/milestones/${id}/events`),
  approveMilestone: (id, body) => request('POST', `/milestones/${id}/release`, body || {}),
  rejectMilestone: (id, body) => request('POST', `/milestones/${id}/reject`, body || {}),
  contribute: (body) => request('POST', '/contributions', body),
  prepareContribution: (body) => request('POST', '/contributions/prepare', body),
  submitSignedContribution: (body) => request('POST', '/contributions/submit-signed', body),
  buildContributionXdr: (body) => request('POST', '/contributions/build-xdr', body),
  guestContribute: (body) => request('POST', '/contributions/guest', body),
  quoteContribution: ({ send_asset, dest_asset, dest_amount }) =>
    request('GET', '/contributions/quote', null, {
      query: { send_asset, dest_asset, dest_amount },
    }),
  getContributionFinalization: (txHash) => request('GET', `/contributions/finalization/${txHash}`),
  failExpiredCampaigns: () => request('POST', '/campaigns/cron/fail-expired'),
  triggerCampaignRefunds: (campaignId) =>
    request('POST', `/campaigns/${campaignId}/trigger-refunds`),
  initiateRefund: (id) => request('POST', `/campaigns/${id}/refund/initiate`, {}),
  approveRefundCreator: (id, body) =>
    request('POST', `/campaigns/${id}/refund/approve/creator`, body || {}),
  approveRefundPlatform: (id) => request('POST', `/campaigns/${id}/refund/approve/platform`, {}),
  requestContributionRefund: (contributionId) =>
    request('POST', `/contributions/${contributionId}/refund`, {}),

  getWithdrawalCapabilities: () => request('GET', '/withdrawals/capabilities'),
  listWithdrawals: (campaignId) => request('GET', `/withdrawals/campaign/${campaignId}`),
  requestWithdrawal: (body) => request('POST', '/withdrawals/request', body),
  approveWithdrawalCreator: (id, body) =>
    request('POST', `/withdrawals/${id}/approve/creator`, body || {}),
  approveWithdrawalPlatform: (id) => request('POST', `/withdrawals/${id}/approve/platform`, {}),
  cancelWithdrawal: (id, body) => request('POST', `/withdrawals/${id}/cancel`, body || {}),
  rejectWithdrawal: (id, body) => request('POST', `/withdrawals/${id}/reject`, body || {}),
  getWithdrawalEvents: (id) => request('GET', `/withdrawals/${id}/events`),
  getWithdrawal: (id) => request('GET', `/withdrawals/${id}`),

  raiseDispute: (campaignId, body) => request('POST', `/campaigns/${campaignId}/disputes`, body),
  getCampaignDisputes: (campaignId) => request('GET', `/campaigns/${campaignId}/disputes`),
  updateDispute: (id, body) => request('PATCH', `/disputes/${id}`, body),
  getDisputeEvents: (id) => request('GET', `/disputes/${id}/events`),

  getAdminStats: () => request('GET', '/admin/stats'),
  getAdminHealth: () => request('GET', '/admin/health'),
  getAdminCampaigns: () => request('GET', '/admin/campaigns'),
  getAdminWithdrawals: (options = {}) =>
    request('GET', '/admin/withdrawals', null, { query: options }),
  getAdminDisputes: (options = {}) => request('GET', '/admin/disputes', null, { query: options }),
  getAdminDispute: (id) => request('GET', `/admin/disputes/${id}`),
  getAdminKycCampaigns: () => request('GET', '/admin/kyc/campaigns'),
  getAdminCampaignContributions: (campaignId, options = {}) =>
    request('GET', `/admin/campaigns/${campaignId}/contributions`, null, { query: options }),
  adminImpersonateUser: (id) => request('POST', `/admin/impersonate/${id}`, {}),
  adminExitImpersonation: () => request('POST', '/admin/impersonate/exit', {}),
  getAdminWebhookDeliveries: (options = {}) =>
    request('GET', '/admin/webhook-deliveries', null, { query: options }),
  adminRetryWebhookDelivery: (id, body) =>
    request('POST', `/admin/webhook-deliveries/${id}/retry`, body),
  adminUpdateUserKyc: (id, body) => request('PATCH', `/admin/users/${id}/kyc`, body),
  getAdminMilestones: (options = {}) =>
    request('GET', '/admin/milestones', null, { query: options }),
  getAdminUsers: (options = {}) => {
    const query =
      typeof options === 'boolean' ? { include_banned: options ? 'true' : 'false' } : options;
    return request('GET', '/admin/users', null, { query });
  },
  getAdminAuditLog: (options = {}) => request('GET', '/admin/audit-log', null, { query: options }),
  updateCampaignStatus: (id, status) =>
    request('PATCH', `/admin/campaigns/${id}/status`, { status }),
  adminSuspendCampaign: (id, body) => request('PATCH', `/admin/campaigns/${id}/suspend`, body),
  adminRestoreCampaign: (id) => request('PATCH', `/admin/campaigns/${id}/restore`, {}),
  adminFeatureCampaign: (id, body) => request('PATCH', `/admin/campaigns/${id}/feature`, body),
  adminUnfeatureCampaign: (id) => request('PATCH', `/admin/campaigns/${id}/unfeature`, {}),
  adminDeleteCampaign: (id, body) => request('DELETE', `/admin/campaigns/${id}`, body),
  adminBanUser: (id, body) => request('PATCH', `/admin/users/${id}/ban`, body),
  adminUnbanUser: (id) => request('PATCH', `/admin/users/${id}/unban`, {}),
  adminPromoteUser: (id) => request('PATCH', `/admin/users/${id}/promote`, {}),
  adminDemoteUser: (id) => request('PATCH', `/admin/users/${id}/demote`, {}),
  listApiKeys: () => request('GET', '/users/api-keys'),
  createApiKey: (body) => request('POST', '/users/api-keys', body),
  deleteApiKey: (id) => request('DELETE', `/users/api-keys/${id}`),
  listWebhooks: () => request('GET', '/webhooks'),
  createWebhook: (body) => request('POST', '/webhooks', body),
  listWebhookDeliveries: (options = {}) =>
    request('GET', '/webhooks/deliveries', null, { query: options }),
  deleteWebhook: (id) => request('DELETE', `/webhooks/${id}`),

  getNotifications: () => request('GET', '/notifications'),
  markNotificationRead: (id) => request('PATCH', `/notifications/${id}/read`, {}),
  markAllNotificationsRead: () => request('PATCH', '/notifications/read-all', {}),

  getReferralCode: (campaignId) => request('GET', `/campaigns/${campaignId}/referral`),
  getReferralLeaderboard: (campaignId) => request('GET', `/campaigns/${campaignId}/referrals`),
};
