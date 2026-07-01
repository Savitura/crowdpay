import { test, expect } from '@playwright/test';

const CREATOR = { email: 'bola@example.com', password: 'creator123' };
const CONTRIBUTOR = { email: 'alice@example.com', password: 'password123' };
const ADMIN = { email: 'admin@example.com', password: 'admin123' };

test.describe('Contributor journey', () => {
  test('register, browse campaigns, open campaign, and see contributions list', async ({ page }) => {
    const email = `e2e-contrib-${Date.now()}@example.com`;

    await page.goto('/register');
    await page.getByPlaceholder('Full name').fill('E2E Contributor');
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill('Password1');
    await page.getByTestId('register-submit').click();

    await expect(page).toHaveURL(/\/($|\?)/);
    await expect(page.getByText(/campaign/i).first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: /solar study hub/i }).first().click();
    await expect(page).toHaveURL(/\/campaigns\//);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/solar/i);

    await page.route('**/api/contributions', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ tx_hash: 'e2e-mock-tx', amount: '5', asset: 'USDC' }),
        });
      }
      return route.continue();
    });

    await page.route('**/api/contributions?*', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'contrib-e2e',
            amount: '5',
            asset: 'USDC',
            sender_public_key: 'GSENDER',
            display_name: 'E2E Contributor',
            created_at: new Date().toISOString(),
          },
        ]),
      });
    });

    await page.getByRole('button', { name: /contribute/i }).click();
    await page.getByLabel(/amount campaign receives/i).fill('5');
    await page.getByRole('button', { name: /confirm payment/i }).click();

    await expect(page.getByText(/E2E Contributor|5/)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Campaign creator journey', () => {
  test('login, create campaign, and see it on home', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(CREATOR.email);
    await page.getByPlaceholder('Password').fill(CREATOR.password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.goto('/campaigns/new');
    const title = `E2E Campaign ${Date.now()}`;
    await page.getByLabel(/title/i).fill(title);
    await page.getByLabel(/description/i).fill('End-to-end test campaign description.');
    await page.getByLabel(/target amount/i).fill('500');
    await page.getByRole('button', { name: /create campaign|launch/i }).click();

    await expect(page).toHaveURL(/\/campaigns\//, { timeout: 20_000 });
    await page.goto('/');
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: title }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(page.getByText(/500/)).toBeVisible();
  });
});

test.describe('Withdrawal flow', () => {
  test('creator sees withdrawal audit trail on funded campaign', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(CREATOR.email);
    await page.getByPlaceholder('Password').fill(CREATOR.password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.goto('/campaigns/22222222-2222-2222-2222-222222222222');
    await expect(page.getByText(/community cold storage|funded/i)).toBeVisible({ timeout: 15_000 });

    await page.route('**/api/withdrawals', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'wr-e2e',
            status: 'pending',
            amount: '100',
            destination_key: 'GBFQZXA6Q4M7BMSNL6Q5M6P47TQIJM47KQKAR5R6XWQ7QX4PX5A7K5TJ',
          }),
        });
      }
      return route.continue();
    });

    await page.route('**/api/withdrawals?*', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'wr-e2e',
            status: 'pending',
            amount: '100',
            destination_key: 'GBFQZXA6Q4M7BMSNL6Q5M6P47TQIJM47KQKAR5R6XWQ7QX4PX5A7K5TJ',
            created_at: new Date().toISOString(),
            approval_events: [{ event_type: 'requested', created_at: new Date().toISOString() }],
          },
        ]),
      });
    });

    const withdrawalSection = page.getByText(/withdrawal/i).first();
    await expect(withdrawalSection).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/audit|pending|request/i).first()).toBeVisible();
  });
});

test.describe('Dispute flow', () => {
  test('contributor disputes a contribution and admin resolves', async ({ page }) => {
    const campaignId = '11111111-1111-1111-1111-111111111111';
    await page.goto(`/campaigns/${campaignId}`);

    // First, ensure there is a contribution to dispute (mock list)
    await page.route('**/api/contributions?*', async (route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'contrib-e2e',
            amount: '10',
            asset: 'USDC',
            sender_public_key: 'GSENDER',
            display_name: 'E2E Contributor',
            created_at: new Date().toISOString(),
          },
        ]),
      });
    });

    // Click on the contribution row to open dispute modal
    await page.getByTestId('contribution-row').first().click();
    await page.getByRole('button', { name: /dispute/i }).click();

    // Fill reason
    await page.getByLabel(/reason/i).fill('Did not receive promised rewards');
    await page.getByRole('button', { name: /submit dispute/i }).click();

    // Mock dispute creation
    await page.route('**/api/disputes', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'dispute-e2e', status: 'pending' }),
        });
      }
      return route.continue();
    });

    await expect(page.getByText(/dispute submitted/i)).toBeVisible();

    // Now switch to admin (or creator) to resolve the dispute
    // In a real test, you might use a separate browser context
    // For simplicity, we'll just navigate to admin dashboard
    // Here we assume admin has a separate login flow
    await page.goto('/logout');
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(ADMIN.email);
    await page.getByPlaceholder('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.goto('/admin/disputes');
    await page.getByText('dispute-e2e').click();
    await page.getByRole('button', { name: /approve|resolve/i }).click();

    // Mock dispute resolution
    await page.route('**/api/disputes/dispute-e2e', async (route) => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 200,
          body: JSON.stringify({ status: 'resolved', resolution: 'refund' }),
        });
      }
      return route.continue();
    });

    await expect(page.getByText(/resolved|refund/i)).toBeVisible();
  });
});

// ========== NEW: Refund Flow ==========
test.describe('Refund flow', () => {
  test('campaign fails target and contributors get auto-refund', async ({ page }) => {
    const campaignId = '33333333-3333-3333-3333-333333333333';
    await page.goto(`/campaigns/${campaignId}`);

    // Simulate campaign that has ended and is below target
    await page.route(`**/api/campaigns/${campaignId}`, async (route) => {
      return route.fulfill({
        status: 200,
        body: JSON.stringify({
          id: campaignId,
          title: 'Failed Campaign',
          target_amount: 1000,
          raised_amount: 200,
          status: 'ended',
          end_date: new Date(Date.now() - 86400000).toISOString(),
        }),
      });
    });

    // Mock refund initiation
    await page.route('**/api/refunds', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          body: JSON.stringify({ refund_id: 'ref-e2e', status: 'processing' }),
        });
      }
      return route.continue();
    });

    // Click refund button (if any) or wait for auto-refund
    await page.getByRole('button', { name: /request refund|claim refund/i }).click();
    await expect(page.getByText(/refund initiated|processing/i)).toBeVisible();
  });
});

// ========== NEW: Soroban Contract Integration ==========
test.describe('Soroban contract integration', () => {
  test('contribution calls contract and reflects on-chain status', async ({ page }) => {
    const email = `e2e-contrib-soroban-${Date.now()}@example.com`;
    await page.goto('/register');
    await page.getByPlaceholder('Full name').fill('Soroban Tester');
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill('Password1');
    await page.getByTestId('register-submit').click();
    await expect(page).toHaveURL(/\/($|\?)/);

    // Navigate to a campaign
    await page.getByRole('link', { name: /solar study hub/i }).first().click();

    // Mock contract call endpoint
    await page.route('**/api/contract/call', async (route) => {
      const body = JSON.parse(route.request().postData());
      if (body.method === 'contribute') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ txHash: '0xabcdef123456', status: 'pending' }),
        });
      }
      return route.continue();
    });

    // Perform contribution
    await page.getByRole('button', { name: /contribute/i }).click();
    await page.getByLabel(/amount campaign receives/i).fill('5');
    await page.getByRole('button', { name: /confirm payment/i }).click();

    // Wait for the UI to show the transaction hash
    await expect(page.getByText(/0xabcdef123456|transaction submitted/i)).toBeVisible();

    // Later, simulate confirmation
    await page.route('**/api/transaction/0xabcdef123456', async (route) => {
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ txHash: '0xabcdef123456', status: 'confirmed', block: 12345 }),
      });
    });
    // Trigger a refresh (e.g., click refresh button)
    await page.getByRole('button', { name: /refresh status/i }).click();
    await expect(page.getByText(/confirmed|success/i)).toBeVisible();
  });
});
