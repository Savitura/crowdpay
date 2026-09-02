import axios from 'axios';

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

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

  async getAdminAuditLogs(params) {
    const res = await apiClient.get('/admin/audit-logs', { params });
    return res.data;
  },

  async exportAdminAuditLogsCsv(params) {
    const res = await apiClient.get('/admin/audit-logs/export.csv', { params, responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'audit-logs.csv';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },

  async exportAdminAuditLogsJson(params) {
    const res = await apiClient.get('/admin/audit-logs/export.json', { params, responseType: 'blob' });
    const disposition = res.headers['content-disposition'] || '';
    let filename = 'audit-logs.json';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
    return { blob: res.data, filename };
  },
};