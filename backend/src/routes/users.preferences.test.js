const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const proxyquire = require("proxyquire").noCallThru();

function buildApp(queryImpl) {
  const router = proxyquire("./users", {
    "../config/database": { query: queryImpl },
    "../middleware/auth": {
      requireAuth: (req, _res, next) => {
        req.user = { userId: "user-1", role: "contributor" };
        next();
      },
    },
    "../services/kycProvider": {
      isKycRequiredForCampaigns: () => false,
    },
    "../services/kycService": {
      startKycForUser: async () => ({ status: "verified" }),
    },
    "../services/userDashboardService": {
      listCreatorCampaigns: async () => [],
      listUserContributions: async () => [],
    },
    "../services/stellarService": {
      getCampaignBalance: async () => "0",
    },
    "../services/analyticsService": {
      getUserDashboardAnalytics: async () => ({}),
    },
    "./apiKeys": express.Router(),
  });

  const app = express();
  app.use(express.json());
  app.use("/api/users", router);
  return app;
}

test("GET /api/users/me/notification-preferences reflects weekly digest opt-out state", async () => {
  const app = buildApp(async (text) => {
    if (text.includes("SELECT email FROM users")) {
      return { rows: [{ email: "backer@example.com" }] };
    }
    if (text.includes("FROM email_unsubscribes")) {
      return { rows: [{ category: "weekly_digest" }] };
    }
    return { rows: [] };
  });

  const res = await request(app).get("/api/users/me/notification-preferences");

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    campaign_update_emails: true,
    weekly_digest_emails: false,
  });
});

test("PATCH /api/users/me/notification-preferences stores weekly digest unsubscribe", async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes("SELECT email FROM users")) {
      return { rows: [{ email: "backer@example.com" }] };
    }
    if (text.includes("FROM email_unsubscribes")) {
      return { rows: [{ category: "weekly_digest" }] };
    }
    return { rows: [] };
  });

  const res = await request(app)
    .patch("/api/users/me/notification-preferences")
    .send({ weekly_digest_emails: false });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    campaign_update_emails: true,
    weekly_digest_emails: false,
  });
  const insert = calls.find((call) => call.text.includes("INSERT INTO email_unsubscribes"));
  assert.ok(insert);
  assert.deepEqual(insert.params, ["backer@example.com", "weekly_digest"]);
});
