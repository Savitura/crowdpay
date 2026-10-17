const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

const PARENT_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';

// Builds the service with a scripted db.query: each call pops the next
// scripted response so membership/integrity checks are deterministic.
function buildService(scripted = []) {
  const calls = [];
  const queue = [...scripted];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const next = queue.shift();
      if (!next) return { rows: [], rowCount: 0 };
      return typeof next === 'function' ? next(calls.length) : next;
    },
  };
  const service = proxyquire('../services/teamCampaignService', {
    '../config/database': db,
  });
  return { service, calls };
}

test('addTeamMember rejects self-membership without touching the database', async () => {
  const { service, calls } = buildService();

  const result = await service.addTeamMember(PARENT_ID, PARENT_ID);

  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(calls.length, 0);
});

test('addTeamMember 404s when the parent campaign is unknown', async () => {
  // First scripted query: parent lookup returns no rows.
  const { service } = buildService([{ rows: [], rowCount: 0 }]);

  const result = await service.addTeamMember(PARENT_ID, MEMBER_ID);

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'Campaign not found');
});

test('addTeamMember rejects a member that is already another team parent', async () => {
  const { service } = buildService([
    { rows: [{ id: PARENT_ID, creator_id: 'user-1' }], rowCount: 1 }, // parent exists
    { rows: [{ is_member: false, is_parent: false }], rowCount: 1 }, // parent membership check: neither
    { rows: [{ id: MEMBER_ID }], rowCount: 1 }, // member exists
    { rows: [{ id: 'x' }], rowCount: 1 }, // member is a parent -> reject
  ]);

  const result = await service.addTeamMember(PARENT_ID, MEMBER_ID);

  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.error, /cannot become a member/);
});

test('addTeamMember inserts and returns the membership row on success', async () => {
  const row = { id: 'row-1', parent_campaign_id: PARENT_ID, member_campaign_id: MEMBER_ID };
  const { service, calls } = buildService([
    { rows: [{ id: PARENT_ID, creator_id: 'user-1' }], rowCount: 1 },
    { rows: [{ is_member: false, is_parent: false }], rowCount: 1 },
    { rows: [{ id: MEMBER_ID }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [row], rowCount: 1 },
  ]);

  const result = await service.addTeamMember(PARENT_ID, MEMBER_ID, {
    role: 'owner',
    display_order: 2,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.member, row);
  const insert = calls[calls.length - 1];
  assert.match(insert.sql, /INSERT INTO team_campaign_members/);
  assert.deepEqual(insert.params, [PARENT_ID, MEMBER_ID, 'owner', 2, null]);
});

test('getTeamPage aggregates member progress and clamps at 100%', async () => {
  const { service } = buildService([
    // listTeamMembers
    {
      rows: [{ member_campaign_id: MEMBER_ID, role: 'owner', display_order: 0 }],
      rowCount: 1,
    },
    // loadCampaignsRows
    {
      rows: [
        {
          id: MEMBER_ID,
          title: 'Team A',
          target_amount: '100',
          raised_amount: '150',
          asset_type: 'XLM',
          status: 'active',
        },
      ],
      rowCount: 1,
    },
  ]);

  const page = await service.getTeamPage(PARENT_ID);

  assert.equal(page.members.length, 1);
  assert.equal(page.members[0].progress_percent, 100); // clamped
  assert.equal(page.totals.member_count, 1);
  assert.equal(page.totals.raised_amount, 150);
  assert.equal(page.totals.progress_percent, 100);
});

test('getTeamPage handles zero targets without dividing by zero', async () => {
  const { service } = buildService([
    { rows: [{ member_campaign_id: MEMBER_ID, role: 'member', display_order: 0 }], rowCount: 1 },
    {
      rows: [
        {
          id: MEMBER_ID,
          title: 'Team B',
          target_amount: '0',
          raised_amount: '0',
          asset_type: 'XLM',
          status: 'active',
        },
      ],
      rowCount: 1,
    },
  ]);

  const page = await service.getTeamPage(PARENT_ID);

  assert.equal(page.members[0].progress_percent, 0);
  assert.equal(page.totals.progress_percent, 0);
});
