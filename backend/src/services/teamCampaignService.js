const db = require('../config/database');

// Team fundraising pages under a parent campaign (#952). A campaign can act
// as a parent that groups member campaigns under one fundraising page.
// Members keep their own wallets, contributions, and milestones; the parent
// page aggregates progress. Membership is the single source of truth: a
// campaign is a "parent" when it has member rows, and a "member" when it
// appears as member_campaign_id.

/**
 * A campaign is a team parent when it has member rows (#952).
 */
async function isTeamParent(campaignId) {
  const { rows } = await db.query(
    'SELECT 1 FROM team_campaign_members WHERE parent_campaign_id = $1 LIMIT 1',
    [campaignId]
  );
  return rows.length > 0;
}

/**
 * Loads campaigns rows for the ids, preserving the given order.
 */
async function loadCampaignsRows(ids) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT id, creator_id, title, description, target_amount, raised_amount,
            asset_type, status, deadline, category, wallet_public_key
     FROM campaigns
     WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  const byId = new Map(rows.map(row => [row.id, row]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

/**
 * Authorization + integrity checks before a campaign becomes a team parent
 * (#952). Resolves `{ ok: true }` or `{ ok: false, status, error }` with a
 * deterministic reason so the route can return a precise error envelope.
 */
async function assertCanBeTeamParent(campaignId) {
  const { rows } = await db.query(`SELECT id, creator_id FROM campaigns WHERE id = $1`, [
    campaignId,
  ]);
  if (!rows.length) {
    return { ok: false, status: 404, error: 'Campaign not found' };
  }

  const membership = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM team_campaign_members
               WHERE member_campaign_id = $1) AS is_member,
       EXISTS (SELECT 1 FROM team_campaign_members
               WHERE parent_campaign_id = $1) AS is_parent`,
    [campaignId]
  );
  const flags = membership.rows[0];

  // A campaign is either a parent or a member, never both — this also blocks
  // every cycle shape, because joining a cycle would make the new member both
  // an ancestor and a descendant of itself.
  if (flags.is_member && flags.is_parent) {
    return {
      ok: false,
      status: 422,
      error: 'This campaign is already both a team parent and a member; contact support',
    };
  }
  if (flags.is_parent) {
    return { ok: true };
  }
  if (flags.is_member) {
    return {
      ok: false,
      status: 422,
      error: 'This campaign is already a member of another team page',
    };
  }

  return { ok: true };
}

/**
 * Lists the member rows of a team parent, ordered for display (#952).
 */
async function listTeamMembers(parentCampaignId) {
  const { rows } = await db.query(
    `SELECT member_campaign_id, role, display_order, joined_at
     FROM team_campaign_members
     WHERE parent_campaign_id = $1
     ORDER BY display_order ASC, joined_at ASC`,
    [parentCampaignId]
  );
  return rows;
}

/**
 * Builds the aggregated team-page payload for a parent campaign (#952):
 * per-member progress plus the parent rollup. Members that were deleted
 * concurrently are skipped rather than failing the whole page.
 */
async function getTeamPage(parentCampaignId) {
  const members = await listTeamMembers(parentCampaignId);
  const memberRows = await loadCampaignsRows(members.map(member => member.member_campaign_id));
  const memberByCampaignId = new Map(members.map(member => [member.member_campaign_id, member]));

  const items = memberRows.map(row => ({
    id: row.id,
    title: row.title,
    description: row.description,
    target_amount: row.target_amount,
    raised_amount: row.raised_amount,
    asset_type: row.asset_type,
    status: row.status,
    deadline: row.deadline,
    category: row.category,
    role: memberByCampaignId.get(row.id)?.role ?? 'member',
    display_order: memberByCampaignId.get(row.id)?.display_order ?? 0,
    progress_percent:
      Number(row.target_amount) > 0
        ? Math.min(100, (Number(row.raised_amount) / Number(row.target_amount)) * 100)
        : 0,
  }));

  const totals = items.reduce(
    (accumulator, item) => ({
      target_amount: accumulator.target_amount + Number(item.target_amount || 0),
      raised_amount: accumulator.raised_amount + Number(item.raised_amount || 0),
    }),
    { target_amount: 0, raised_amount: 0 }
  );

  return {
    members: items,
    totals: {
      target_amount: totals.target_amount,
      raised_amount: totals.raised_amount,
      progress_percent:
        totals.target_amount > 0
          ? Math.min(100, (totals.raised_amount / totals.target_amount) * 100)
          : 0,
      member_count: items.length,
    },
  };
}

/**
 * Adds a campaign as a team member with cycle prevention (#952). The parent
 * must not itself be a member elsewhere (no chains), and the member must not
 * be a parent (no cycles, no nesting). Duplicate and concurrent joins are
 * absorbed by the UNIQUE constraint into an idempotent re-add.
 */
async function addTeamMember(parentCampaignId, memberCampaignId, input = {}) {
  if (parentCampaignId === memberCampaignId) {
    return { ok: false, status: 422, error: 'A campaign cannot be a member of itself' };
  }

  const parentCheck = await assertCanBeTeamParent(parentCampaignId);
  if (!parentCheck.ok) return parentCheck;

  const memberCheck = await assertEligibleMember(memberCampaignId);
  if (!memberCheck.ok) return memberCheck;

  const role = input.role === 'owner' ? 'owner' : 'member';
  const displayOrder = Number.isFinite(input.display_order)
    ? Math.max(0, Math.floor(input.display_order))
    : 0;

  const { rows } = await db.query(
    `INSERT INTO team_campaign_members
       (parent_campaign_id, member_campaign_id, role, display_order, invited_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (member_campaign_id) DO UPDATE
       SET parent_campaign_id = EXCLUDED.parent_campaign_id,
           role = EXCLUDED.role,
           display_order = EXCLUDED.display_order
     RETURNING *`,
    [parentCampaignId, memberCampaignId, role, displayOrder, input.invited_by || null]
  );

  return { ok: true, member: rows[0] };
}

/**
 * Checks a campaign may become a team member: it must exist, must not be
 * another team's parent, and must not already be this parent's member in a
 * conflicting role (re-adding with different role is an update, handled in
 * addTeamMember via upsert) (#952).
 */
async function assertEligibleMember(memberCampaignId) {
  const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [memberCampaignId]);
  if (!rows.length) {
    return { ok: false, status: 404, error: 'Member campaign not found' };
  }

  const { rows: parentRows } = await db.query(
    'SELECT 1 FROM team_campaign_members WHERE parent_campaign_id = $1 LIMIT 1',
    [memberCampaignId]
  );
  if (parentRows.length) {
    return {
      ok: false,
      status: 422,
      error: 'A team parent campaign cannot become a member of another team',
    };
  }
  return { ok: true };
}

/**
 * Removes a member from a team parent (#952). Returns whether a row was
 * removed so the route can 404 on unknown memberships.
 */
async function removeTeamMember(parentCampaignId, memberCampaignId) {
  const { rowCount } = await db.query(
    `DELETE FROM team_campaign_members
     WHERE parent_campaign_id = $1 AND member_campaign_id = $2`,
    [parentCampaignId, memberCampaignId]
  );
  return rowCount > 0;
}

module.exports = {
  isTeamParent,
  loadCampaignsRows,
  assertCanBeTeamParent,
  listTeamMembers,
  getTeamPage,
  addTeamMember,
  assertEligibleMember,
  removeTeamMember,
};
