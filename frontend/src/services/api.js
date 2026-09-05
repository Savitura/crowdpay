import axios from 'axios';

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

// --- Offline retry queue ---
// Idempotent GET requests that fail with a network error while the app is
// offline are queued here and replayed when connectivity returns
// (NetworkStatusContext calls retryQueuedRequests on reconnect).
const retryQueue = [];

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const config = error.config;
    if (!error.response && config && config.method === 'get' && !config._retried) {
      config._retried = true;
      retryQueue.push(() => apiClient.request(config));
    }
    return Promise.reject(error);
  }
);

export function retryQueuedRequests() {
  const queue = [...retryQueue];
  retryQueue.length = 0;
  for (const replay of queue) {
    replay().catch(() => { /* replayed request failed again — drop it */ });
  }
}

export const api = {
  async getCampaign(id) {
    const res = await apiClient.get(`/campaigns/${id}`);
    return res.data;
  },
  async getReferralProgram(id) {
    const res = await apiClient.get(`/campaigns/${id}/referrals/program`);
    return res.data;
  },
  async createReferralLink(id) {
    const res = await apiClient.post(`/campaigns/${id}/referrals/links`);
    return res.data;
  },
  async getCreatorCampaignAnalytics(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}`);
    return res.data;
  },
  async exportCreatorCampaignData(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}/export`, { responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'campaign-export.csv';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
  async exportCampaignReport(campaignId) {
    const res = await apiClient.get(`/campaigns/${campaignId}/report/export`, { responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'campaign-report.pdf';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
  async getCampaignVelocity(campaignId) {
    const res = await apiClient.get(`/creator/campaigns/${campaignId}/velocity`);
    return res.data;
  },
  async updateVelocityThreshold(campaignId, threshold) {
    const res = await apiClient.patch(`/creator/campaigns/${campaignId}/velocity/threshold`, { threshold });
    return res.data;
  },
  async getNotificationPreferences() {
    const res = await apiClient.get('/users/me/notification-preferences');
    return res.data;
  },
  async updateNotificationPreference(data) {
    const res = await apiClient.patch('/users/me/notification-preferences', data);
    return res.data;
  },
  async unsubscribeEmail(data) {
    const res = await apiClient.get('/emails/unsubscribe', { params: data });
    return res.data;
  },
  async getChannelSettings() {
    const res = await apiClient.get('/users/me/channel-settings');
    return res.data;
  },
  async updateChannelSettings(data) {
    const res = await apiClient.patch('/users/me/channel-settings', data);
    return res.data;
  },
  async getPushSubscriptionStatus() {
    const res = await apiClient.get('/users/me/push-subscription');
    return res.data;
  },
  async registerPushSubscription(token) {
    const res = await apiClient.post('/users/me/push-subscription', { token });
    return res.data;
  },
  async removePushSubscription(token) {
    const res = await apiClient.delete('/users/me/push-subscription', { data: { token } });
    return res.data;
  },
  async getMyCampaigns(params) {
    const res = await apiClient.get('/users/me/campaigns', { params });
    return res.data;
  },
  async getNotifications() {
    const res = await apiClient.get('/users/me/notifications');
    return res.data;
  },
  async markNotificationRead(id) {
    const res = await apiClient.patch(`/users/me/notifications/${id}/read`);
    return res.data;
  },
  async markAllNotificationsRead() {
    const res = await apiClient.patch('/users/me/notifications/read-all');
    return res.data;
  },
  async getMyBadges() {
    const res = await apiClient.get('/users/me/badges');
    return res.data;
  },
  async getMyNftRewards() {
    const res = await apiClient.get('/users/me/nft-rewards');
    return res.data;
  },
  async setup2FA() {
    const res = await apiClient.post('/users/me/2fa/setup');
    return res.data;
  },
  async verify2FA({ code }) {
    const res = await apiClient.post('/users/me/2fa/verify', { code });
    return res.data;
  },
};