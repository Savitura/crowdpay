import { defineConfig, devices } from '@playwright/test';

const backendEnv = {
  NODE_ENV: 'development',
  PORT: '3001',
  JWT_SECRET: 'testsecret',
  STELLAR_NETWORK: 'testnet',
  USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  PLATFORM_SECRET_KEY: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  WALLET_SECRET_LOCAL_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  KYC_REQUIRED_FOR_CAMPAIGNS: 'false',
  ENABLE_CAMPAIGN_STATUS_CRON: 'false',
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5433/crowdpay',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev',
      cwd: 'backend',
      url: 'http://localhost:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: backendEnv,
    },
    {
      command: 'npm run dev',
      cwd: 'frontend',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
