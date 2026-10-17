import { test, expect } from '@playwright/test';

const publicRoutes = [
  ['/', /Fund Nigerian causes/i],
  ['/discover', /Explore campaigns/i],
  ['/how-it-works', /How CrowdPay works/i],
  ['/pricing', /^Pricing$/i],
  ['/about', /About CrowdPay/i],
  ['/resources', /Resources/i],
  ['/login', /^Log in$/i],
  ['/register', /Create account/i],
];

test.describe('Public launch routes', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/governance/fee')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ platform_fee_bps: 250 }) });
      }
      if (url.pathname.endsWith('/campaigns/categories')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      if (url.pathname.endsWith('/campaigns/facets')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ categories: [], assets: [], countries: [], funding: { min: 0, max: 0 }, verified_creators: 0 }) });
      }
      if (url.pathname.endsWith('/campaigns/featured')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      if (url.pathname.endsWith('/campaigns')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ campaigns: [], total: 0 }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
  });

  for (const [path, heading] of publicRoutes) {
    test(`${path} renders without the global error boundary`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByRole('heading', { name: /Something went wrong/i })).toHaveCount(0);
    });
  }

  test('discover offers a recovery action when the API is unavailable', async ({ page }) => {
    await page.unroute('**/api/**');
    await page.route('**/api/**', (route) => route.abort('failed'));
    await page.goto('/discover');
    await expect(page.getByRole('alert')).toContainText(/temporarily unavailable/i);
    await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
  });
});
