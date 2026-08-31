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

test("GET /api/users/me/notification-preferences reflects notification_preferences state", async () => {
  const app = buildApp(async (text) => {
    if (text.includes("FROM notification_preferences")) {
      return { rows: [{ campaign_updates: true, refunds: true, disputes: true, milestones: true, marketing: false }] };
    }
    return { rows: [] };
  });

  const res = await request(app).get("/api/users/me/notification-preferences");

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    campaign_updates: true,
    refunds: true,
    disputes: true,
    milestones: true,
    marketing: false,
  });
});

test("PATCH /api/users/me/notification-preferences stores preferences", async () => {
  const calls = [];
  const app = buildApp(async (text, params) => {
    calls.push({ text, params });
    if (text.includes("FROM notification_preferences")) {
      return { rows: [{ campaign_updates: true, refunds: true, disputes: true, milestones: true, marketing: true }] };
    }
    return { rows: [] };
  });

  const res = await request(app)
    .patch("/api/users/me/notification-preferences")
    .send({ campaign_updates: false, marketing: false });

  assert.equal(res.status, 200);
  
  const insert = calls.find((call) => call.text.includes("INSERT INTO notification_preferences"));
  assert.ok(insert);
  
  assert.deepEqual(insert.params, ["user-1", false, null, null, null, false]);
});
