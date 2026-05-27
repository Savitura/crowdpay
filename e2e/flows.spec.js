import { test, expect } from '@playwright/test';

const CREATOR = { email: 'bola@example.com', password: 'creator123' };
const CONTRIBUTOR = { email: 'alice@example.com', password: 'password123' };

test.describe('Contributor journey', () => {
  test('register, browse campaigns, open campaign, and see contributions list', async ({ page }) => {
    const email = `e2e-contrib-${Date.now()}@example.com`;

    await page.goto('/register');
    await page.getByPlaceholder('Full name').fill('E2E Contributor');
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill('Password1');
    await page.getByRole('button', { name: /sign up/i }).click();

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
