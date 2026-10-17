'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

const db = require('../config/database');
const {
  getCampaignAnalytics,
  getCampaignContributors,
  getCampaignBackers,
  getUserDashboardAnalytics,
  _analyticsCache,
} = require('./analyticsService');

const TEST_CAMPAIGN_ID = 'test-campaign-analytics';

describe('analyticsService', () => {
  let dbQueryMock;

  beforeEach(() => {
    _analyticsCache.clear();
    dbQueryMock = mock.method(db, 'query');
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getCampaignAnalytics', () => {
    it('returns null for non-existent campaign', async () => {
      dbQueryMock.mock.mockImplementation(() => Promise.resolve({ rows: [] }));
      const result = await getCampaignAnalytics('non-existent');
      assert.strictEqual(result, null);
    });

    it('returns analytics with bounded daily_buckets for short campaign', async () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-01-10'); // 10 days
      dbQueryMock.mock.mockImplementation((sql, params) => {
        if (sql.includes('FROM campaigns')) {
          return Promise.resolve({
            rows: [
              {
                created_at: start,
                deadline: end,
                raised_amount: '1000',
                target_amount: '5000',
                asset_type: 'USDC',
              },
            ],
          });
        }
        if (sql.includes('DATE(created_at)') && sql.includes('contributions')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('total_contributions')) {
          return Promise.resolve({
            rows: [
              {
                total_contributions: 0,
                unique_contributors: 0,
                avg_contribution: 0,
                recurring_contributions: 0,
                recurring_total: 0,
              },
            ],
          });
        }
        if (sql.includes('currency')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await getCampaignAnalytics(TEST_CAMPAIGN_ID);
      assert.ok(result);
      assert.ok(result.daily_buckets);
      assert.strictEqual(result.daily_buckets.length, 10);
      assert.strictEqual(result.daily_buckets_meta.max_buckets, 365);
      assert.strictEqual(result.daily_buckets_meta.range_clamped, false);
    });

    it('clamps daily_buckets to 365 for multi-year campaign', async () => {
      const start = new Date('2020-01-01');
      const end = new Date('2025-01-01'); // ~5 years = ~1826 days
      dbQueryMock.mock.mockImplementation(sql => {
        if (sql.includes('FROM campaigns')) {
          return Promise.resolve({
            rows: [
              {
                created_at: start,
                deadline: end,
                raised_amount: '1000',
                target_amount: '5000',
                asset_type: 'USDC',
              },
            ],
          });
        }
        if (sql.includes('DATE(created_at)') && sql.includes('contributions')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('total_contributions')) {
          return Promise.resolve({
            rows: [
              {
                total_contributions: 0,
                unique_contributors: 0,
                avg_contribution: 0,
                recurring_contributions: 0,
                recurring_total: 0,
              },
            ],
          });
        }
        if (sql.includes('currency')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await getCampaignAnalytics(TEST_CAMPAIGN_ID);
      assert.ok(result);
      assert.strictEqual(result.daily_buckets.length, 365);
      assert.strictEqual(result.daily_buckets_meta.max_buckets, 365);
      assert.strictEqual(result.daily_buckets_meta.range_clamped, true);
      // Effective start should be 364 days before end (365 buckets total)
      const expectedStart = new Date(end.getTime() - 364 * 24 * 60 * 60 * 1000);
      assert.strictEqual(
        result.daily_buckets_meta.effective_start,
        expectedStart.toISOString().slice(0, 10)
      );
    });

    it('includes zero-contribution days in buckets', async () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-01-05'); // 5 days
      dbQueryMock.mock.mockImplementation(sql => {
        if (sql.includes('FROM campaigns')) {
          return Promise.resolve({
            rows: [
              {
                created_at: start,
                deadline: end,
                raised_amount: '1000',
                target_amount: '5000',
                asset_type: 'USDC',
              },
            ],
          });
        }
        if (sql.includes('DATE(created_at)') && sql.includes('contributions')) {
          // Only 2 days have contributions
          return Promise.resolve({
            rows: [
              { day: new Date('2024-01-01'), contribution_count: 2, total_amount: '100' },
              { day: new Date('2024-01-03'), contribution_count: 1, total_amount: '50' },
            ],
          });
        }
        if (sql.includes('total_contributions')) {
          return Promise.resolve({
            rows: [
              {
                total_contributions: 3,
                unique_contributors: 2,
                avg_contribution: 50,
                recurring_contributions: 0,
                recurring_total: 0,
              },
            ],
          });
        }
        if (sql.includes('currency')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await getCampaignAnalytics(TEST_CAMPAIGN_ID);
      console.log('Result daily_buckets:', result.daily_buckets);
      assert.ok(result.daily_buckets);
      assert.strictEqual(result.daily_buckets.length, 5);
      // Check zero-contribution days are filled - day values can be Date objects or strings
      const getDayKey = b => (b.day instanceof Date ? b.day.toISOString().slice(0, 10) : b.day);
      const day1 = result.daily_buckets.find(b => getDayKey(b) === '2024-01-01');
      const day2 = result.daily_buckets.find(b => getDayKey(b) === '2024-01-02');
      const day3 = result.daily_buckets.find(b => getDayKey(b) === '2024-01-03');
      assert.ok(day1, 'day1 not found');
      assert.ok(day2, 'day2 not found');
      assert.ok(day3, 'day3 not found');
      assert.strictEqual(day1.contribution_count, 2);
      assert.strictEqual(day2.contribution_count, 0);
      assert.strictEqual(day3.contribution_count, 1);
    });
  });

  describe('getCampaignContributors', () => {
    it('returns repeat and first-time contributor counts', async () => {
      dbQueryMock.mock.mockImplementation(sql => {
        if (sql.includes('repeat_contributors')) {
          return Promise.resolve({
            rows: [{ repeat_contributors: 3, first_time_contributors: 7 }],
          });
        }
        if (sql.includes('country')) {
          return Promise.resolve({
            rows: [
              { country: 'US', contributor_count: 5 },
              { country: 'UK', contributor_count: 3 },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await getCampaignContributors(TEST_CAMPAIGN_ID);
      assert.strictEqual(result.repeat_contributors, 3);
      assert.strictEqual(result.first_time_contributors, 7);
      assert.strictEqual(result.country_breakdown.length, 2);
    });
  });

  describe('getCampaignBackers', () => {
    it('computes total_backers and repeat_rate in single query', async () => {
      dbQueryMock.mock.mockImplementation(sql => {
        if (sql.includes('new_backers')) {
          return Promise.resolve({ rows: [{ day: '2024-01-01', new_backers: 2 }] });
        }
        if (
          sql.includes('top_backers') ||
          (sql.includes('sender_public_key') && sql.includes('LIMIT 10'))
        ) {
          return Promise.resolve({
            rows: [
              { sender_public_key: 'key1', contribution_count: 5, total_amount: '500' },
              { sender_public_key: 'key2', contribution_count: 2, total_amount: '200' },
            ],
          });
        }
        if (sql.includes('total_backers') && sql.includes('repeat_rate')) {
          return Promise.resolve({ rows: [{ total_backers: 10, repeat_rate: '30.00' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await getCampaignBackers(TEST_CAMPAIGN_ID);
      assert.strictEqual(result.total_backers, 10);
      assert.strictEqual(result.repeat_rate, 30.0);
      assert.strictEqual(result.top_backers.length, 2);
      assert.strictEqual(result.new_backers_by_day.length, 1);
    });

    it('handles duplicate sender case correctly', async () => {
      dbQueryMock.mock.mockImplementation(sql => {
        if (sql.includes('new_backers')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('sender_public_key') && sql.includes('LIMIT 10')) {
          return Promise.resolve({
            rows: [
              { sender_public_key: 'key1', contribution_count: 3, total_amount: '300' },
              { sender_public_key: 'key2', contribution_count: 1, total_amount: '100' },
            ],
          });
        }
        if (sql.includes('total_backers') && sql.includes('repeat_rate')) {
          // 2 unique senders, 1 has 3 contributions (repeat), 1 has 1 (first-time)
          // repeat_rate = 1/2 * 100 = 50%
          return Promise.resolve({ rows: [{ total_backers: 2, repeat_rate: '50.00' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await getCampaignBackers(TEST_CAMPAIGN_ID);
      assert.strictEqual(result.total_backers, 2);
      assert.strictEqual(result.repeat_rate, 50.0);
    });
  });

  describe('getUserDashboardAnalytics', () => {
    it('returns all analytics sections', async () => {
      dbQueryMock.mock.mockImplementation(sql => {
        if (sql.includes('total_campaigns')) {
          return Promise.resolve({
            rows: [
              {
                total_campaigns: 2,
                total_raised: '1000',
                total_contributions: 10,
                unique_contributors: 8,
                avg_contribution: 100,
                recurring_contributions: 1,
                recurring_raised: '100',
              },
            ],
          });
        }
        if (
          sql.includes('recent_trend') ||
          (sql.includes('DATE(ctr.created_at)') && sql.includes('30 days'))
        ) {
          return Promise.resolve({
            rows: [{ day: '2024-01-01', contribution_count: 2, total_amount: '200' }],
          });
        }
        if (
          sql.includes('top_campaigns') ||
          (sql.includes('c.id') && sql.includes('ORDER BY c.raised_amount'))
        ) {
          return Promise.resolve({
            rows: [
              {
                id: 'c1',
                title: 'Campaign 1',
                raised_amount: '500',
                target_amount: '1000',
                asset_type: 'USDC',
                contribution_count: 5,
              },
            ],
          });
        }
        if (sql.includes('funding_velocity') || sql.includes('daily_amount')) {
          return Promise.resolve({
            rows: [
              { campaign_id: 'c1', title: 'Campaign 1', day: '2024-01-01', daily_amount: '100' },
            ],
          });
        }
        if (sql.includes('contributor_retention') || sql.includes('returning_count')) {
          return Promise.resolve({
            rows: [{ month: '2024-01', returning_count: 3, new_count: 7 }],
          });
        }
        if (sql.includes('referral_conversion') || sql.includes('referral_code')) {
          return Promise.resolve({
            rows: [
              {
                referral_code: 'abc123',
                click_count: 10,
                contribution_count: 2,
                conversion_rate: '20.00',
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await getUserDashboardAnalytics('user-1');
      assert.ok(result.overview);
      assert.ok(result.recent_trend);
      assert.ok(result.top_campaigns);
      assert.ok(result.funding_velocity);
      assert.ok(result.contributor_retention);
      assert.ok(result.referral_conversion);
    });
  });

  describe('cache invalidation', () => {
    it('cache can be cleared', () => {
      _analyticsCache.set('test-key', { data: 'test' });
      assert.ok(_analyticsCache.has('test-key'));
      _analyticsCache.clear();
      assert.ok(!_analyticsCache.has('test-key'));
    });
  });
});
