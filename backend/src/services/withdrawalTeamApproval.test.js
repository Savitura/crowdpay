const test = require('node:test');
const assert = require('node:assert/strict');
const { campaignPolicy, teamApproval, assertTeamApproved } = require('./withdrawalTeamApproval');

function fixture() {
  const campaign = { id: 'campaign', creator_id: 'creator', withdrawal_team_approvals_required: 1 };
  const row = {
    id: 'withdrawal',
    campaign_id: campaign.id,
    creator_id: 'creator',
    requested_by: 'creator',
    team_approvals_required: 1,
    status: 'pending',
    platform_signed: false,
  };
  const members = [{ id: 'member', user_id: 'owner' }];
  const votes = [];
  const calls = [];
  const client = {
    query: async (sql, args) => {
      calls.push(sql);
      if (sql.includes('FROM campaign_members')) return { rows: members };
      if (sql.includes('FROM campaigns')) return { rows: [campaign] };
      if (sql.includes('FROM withdrawal_requests')) return { rows: [row] };
      if (sql.includes('FROM withdrawal_team_approvals')) return { rows: votes };
      if (sql.includes('INSERT INTO withdrawal_team_approvals')) {
        const vote = votes.find(v => v.user_id === args[1]);
        if (vote) vote.member_id = args[2];
        else votes.push({ user_id: args[1], member_id: args[2] });
      }
      return { rows: [] };
    },
  };
  return { campaign, row, members, votes, calls, client };
}

test('creator configures bounded quorum; owners cannot change or disable it', async () => {
  const { client, calls } = fixture();
  assert.equal((await campaignPolicy(client, 'campaign', 'creator', 1)).required_approvals, 1);
  await assert.rejects(campaignPolicy(client, 'campaign', 'owner', 0), { status: 403 });
  await assert.rejects(campaignPolicy(client, 'campaign', 'outsider'), { status: 403 });
  for (const value of [-1, 11, 1.5, '1', null]) {
    await assert.rejects(campaignPolicy(client, 'campaign', 'creator', value), { status: 400 });
  }
  await assert.rejects(campaignPolicy(client, 'campaign', 'creator', 2), { status: 409 });
  assert.ok(calls.some(sql => sql.includes('FOR UPDATE')));
});

test('other owner approves once, satisfying the platform gate without a wallet signature', async () => {
  const { client, row, votes, calls } = fixture();
  await assert.rejects(assertTeamApproved(client, row), { status: 409 });
  const result = await teamApproval(client, row.id, 'owner', true);
  assert.equal(result.satisfied, true);
  assert.equal(result.approvals, 1);
  assert.equal(result.approved_by_me, true);
  await teamApproval(client, row.id, 'owner', true);
  assert.equal(votes.length, 1);
  await assertTeamApproved(client, row);
  assert.ok(calls.some(sql => sql.includes('FOR UPDATE OF wr, c')));
  assert.ok(calls.some(sql => sql.includes('FOR SHARE')));
});

test('requester, outsider, expired and completed requests cannot add votes', async () => {
  const { client, row, votes } = fixture();
  await assert.rejects(teamApproval(client, row.id, 'creator', true), { status: 403 });
  await assert.rejects(teamApproval(client, row.id, 'outsider', true), { status: 403 });
  for (const status of ['approved', 'submitted', 'failed', 'denied', 'expired']) {
    row.status = status;
    await assert.rejects(teamApproval(client, row.id, 'owner', true), { status: 409 });
  }
  row.status = 'pending';
  row.expires_at = '2000-01-01';
  await assert.rejects(teamApproval(client, row.id, 'owner', true), { status: 409 });
  assert.equal(votes.length, 0);
});

test('removal or reinvitation invalidates old approvals; policy changes do not weaken a snapshot', async () => {
  const { client, row, members, campaign } = fixture();
  await teamApproval(client, row.id, 'owner', true);
  members[0].id = 'new-invitation';
  campaign.withdrawal_team_approvals_required = 0;
  await assert.rejects(assertTeamApproved(client, row), { status: 409 });
  await teamApproval(client, row.id, 'owner', true);
  await assertTeamApproved(client, row);
  members.length = 0;
  await assert.rejects(assertTeamApproved(client, row), { status: 409 });
});

test('legacy requests and refunds retain the original signing path', async () => {
  const client = {
    query: () => {
      throw new Error('No team query expected');
    },
  };
  await assertTeamApproved(client, { team_approvals_required: 0 });
  await assertTeamApproved(client, { is_refund: true, team_approvals_required: 2 });
});
