process.env.USDC_ISSUER =
  process.env.USDC_ISSUER ||
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK || "testnet";
process.env.PLATFORM_SECRET_KEY =
  process.env.PLATFORM_SECRET_KEY ||
  "SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validationResult } = require("express-validator");
const {
  registerValidation,
  createCampaignValidation,
  contributionValidation,
  withdrawalValidation,
  createAnnouncementValidation,
  announcementIdValidation,
} = require("../middleware/validation");

async function runValidation(validations, body = {}, query = {}, params = {}) {
  const req = { body, query, params };
  for (const fn of validations) {
    await fn(req, {}, () => {});
  }
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return { ok: false, errors: result.array(), req };
  }
  return { ok: true, req };
}

test("register validation rejects invalid email and short password", async () => {
  const result = await runValidation(registerValidation, {
    email: "not-an-email",
    password: "short",
    name: "",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
});

test("createCampaign validation rejects title longer than 100 characters", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "x".repeat(101),
    target_amount: "10",
    asset_type: "USDC",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "title"));
});

test("contribution validation rejects non-UUID campaign_id", async () => {
  const result = await runValidation(contributionValidation, {
    campaign_id: "not-a-uuid",
    amount: "5",
    send_asset: "XLM",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "campaign_id"));
});

test("withdrawal validation rejects invalid Stellar destination key", async () => {
  const result = await runValidation(withdrawalValidation, {
    campaign_id: "11111111-1111-1111-1111-111111111111",
    amount: "10",
    destination_key: "invalid-key",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "destination_key"));
});

test("createAnnouncement validation rejects invalid announcement fields", async () => {
  const result = await runValidation(createAnnouncementValidation, {
    message: "",
    severity: "urgent",
    details_url: "not-a-url",
    active_from: "2026-07-25T12:00:00.000Z",
    active_until: "2026-07-25T11:00:00.000Z",
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "message"));
  assert.ok(result.errors.some((e) => e.path === "severity"));
  assert.ok(result.errors.some((e) => e.path === "details_url"));
  assert.ok(result.errors.some((e) => e.path === "active_until"));
});

test("createAnnouncement validation accepts a minimal valid payload", async () => {
  const result = await runValidation(createAnnouncementValidation, {
    message: "Scheduled maintenance",
  });

  assert.equal(result.ok, true);
});

test("createAnnouncement validation normalizes blank optional fields", async () => {
  const body = {
    message: "Scheduled maintenance",
    severity: "",
    details_url: "",
    active_from: "",
    active_until: "",
  };
  const result = await runValidation(createAnnouncementValidation, body);

  assert.equal(result.ok, true);
  assert.equal(body.severity, null);
  assert.equal(body.details_url, null);
  assert.equal(body.active_from, null);
  assert.equal(body.active_until, null);
});

test("createAnnouncement validation rejects active_until in the past without active_from", async () => {
  const result = await runValidation(createAnnouncementValidation, {
    message: "Expired announcement",
    active_until: "2000-01-01T00:00:00.000Z",
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) => e.path === "active_until" && /future/.test(e.msg),
    ),
  );
});

test("announcementId validation rejects non-UUID ids", async () => {
  const result = await runValidation(
    announcementIdValidation,
    {},
    {},
    {
      id: "not-a-uuid",
    },
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "id"));
});

test("register validation passes for valid payload", async () => {
  const result = await runValidation(registerValidation, {
    email: "user@example.com",
    password: "Password1",
    name: "Test User",
  });
  assert.equal(result.ok, true);
});

test("createCampaign validation rejects negative max_per_user", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Valid Title",
    target_amount: "10",
    asset_type: "USDC",
    max_per_user: "-5",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "max_per_user"));
});

test("createCampaign validation rejects max_per_user less than or equal to min_contribution", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Valid Title",
    target_amount: "100",
    asset_type: "USDC",
    min_contribution: "10",
    max_per_user: "10",
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) =>
        e.path === "max_per_user" &&
        e.msg ===
          "Per-contributor cap must be greater than minimum contribution",
    ),
  );
});

test("createCampaign validation passes with valid limit parameters", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Valid Title",
    target_amount: "100",
    asset_type: "USDC",
    min_contribution: "10",
    max_contribution: "50",
    max_per_user: "80",
  });
  assert.equal(result.ok, true);
});

// Milestone percentage total validation tests
test("createCampaign validation rejects milestone percentages exceeding 100%", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Test Campaign",
    target_amount: "100",
    asset_type: "USDC",
    milestones: [
      { title: "Milestone 1", release_percentage: 80 },
      { title: "Milestone 2", release_percentage: 80 },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) => e.msg === "Milestone percentages must not exceed 100%",
    ),
  );
});

test("createCampaign validation accepts milestone percentages totalling exactly 100%", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Test Campaign",
    target_amount: "100",
    asset_type: "USDC",
    milestones: [
      { title: "Milestone 1", release_percentage: 40 },
      { title: "Milestone 2", release_percentage: 60 },
    ],
  });
  assert.equal(result.ok, true);
});

test("createCampaign validation accepts milestone percentages totalling less than 100%", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Test Campaign",
    target_amount: "100",
    asset_type: "USDC",
    milestones: [
      { title: "Milestone 1", release_percentage: 40 },
      { title: "Milestone 2", release_percentage: 30 },
    ],
  });
  assert.equal(result.ok, true);
});

test("createCampaign validation accepts single milestone with 100%", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Test Campaign",
    target_amount: "100",
    asset_type: "USDC",
    milestones: [{ title: "Milestone 1", release_percentage: 100 }],
  });
  assert.equal(result.ok, true);
});

test("createCampaign validation accepts four milestones with 25% each", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Test Campaign",
    target_amount: "100",
    asset_type: "USDC",
    milestones: [
      { title: "Milestone 1", release_percentage: 25 },
      { title: "Milestone 2", release_percentage: 25 },
      { title: "Milestone 3", release_percentage: 25 },
      { title: "Milestone 4", release_percentage: 25 },
    ],
  });
  assert.equal(result.ok, true);
});

test("createCampaign validation rejects milestone percentages with floating point exceeding 100%", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Test Campaign",
    target_amount: "100",
    asset_type: "USDC",
    milestones: [
      { title: "Milestone 1", release_percentage: 50.1 },
      { title: "Milestone 2", release_percentage: 50.1 },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) => e.msg === "Milestone percentages must not exceed 100%",
    ),
  );
});

test("contribution validation rejects display_name longer than 50 characters", async () => {
  const result = await runValidation(contributionValidation, {
    campaign_id: "123e4567-e89b-12d3-a456-426614174000",
    amount: "10",
    send_asset: "XLM",
    display_name: "a".repeat(51),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) => e.msg === "Display name must be at most 50 characters",
    ),
  );
});

test("contribution validation rejects display_name with null bytes or control characters", async () => {
  const result = await runValidation(contributionValidation, {
    campaign_id: "123e4567-e89b-12d3-a456-426614174000",
    amount: "10",
    send_asset: "XLM",
    display_name: "Bad\0User",
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) =>
        e.msg ===
        "Display name contains invalid control characters or null bytes",
    ),
  );
});

test("contribution validation trims whitespace on valid display_name", async () => {
  const result = await runValidation(contributionValidation, {
    campaign_id: "123e4567-e89b-12d3-a456-426614174000",
    amount: "10",
    send_asset: "XLM",
    display_name: "   Alice   ",
  });
  assert.equal(result.ok, true);
  assert.equal(result.req.body.display_name, "Alice");
});

test("contribution validation applies the exact-stroop amount rule (#840)", async () => {
  const base = { campaign_id: "123e4567-e89b-12d3-a456-426614174000", send_asset: "XLM" };
  for (const amount of ["8.29", "19.99", "0.0000001", "922337203685.4775807", "1.50000000"]) {
    const result = await runValidation(contributionValidation, { ...base, amount });
    assert.equal(result.ok, true, `${amount} should be accepted`);
  }
  for (const amount of ["8.290000001", "0.00000001", "922337203685.4775808", "0", "-1"]) {
    const result = await runValidation(contributionValidation, { ...base, amount });
    assert.equal(result.ok, false, `${amount} should be rejected`);
    assert.ok(result.errors.some((e) => e.path === "amount"));
  }
});

test("createCampaign validation rejects a target_amount with more than 7 decimals", async () => {
  const result = await runValidation(createCampaignValidation, {
    title: "Exact target",
    target_amount: "100.12345678",
    asset_type: "USDC",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "target_amount"));
});
