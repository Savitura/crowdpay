function policyError(message, status = 409) {
  const error = new Error(message);
  error.status = status;
  error.code = 'withdrawal_team_approval';
  return error;
}

async function owners(client, campaign) {
  // Hold membership locks through the approval/platform transaction so a concurrent
  // removal or demotion cannot race the authorization check.
  const { rows } = await client.query(
    `SELECT id, user_id FROM campaign_members
     WHERE campaign_id = $1 AND role = 'owner' AND accepted_at IS NOT NULL
       AND user_id IS NOT NULL ORDER BY id FOR SHARE`,
    [campaign.id || campaign.campaign_id]
  );
  const eligible = new Map([[campaign.creator_id, null]]);
  for (const row of rows) {
    if (!eligible.has(row.user_id)) eligible.set(row.user_id, row.id);
  }
  return eligible;
}

async function campaignPolicy(client, campaignId, userId, required) {
  const { rows } = await client.query(
    'SELECT id, creator_id, withdrawal_team_approvals_required FROM campaigns WHERE id = $1 FOR UPDATE',
    [campaignId]
  );
  if (!rows.length) throw policyError('Campaign not found', 404);
  const campaign = rows[0];
  const eligible = await owners(client, campaign);
  if (!eligible.has(userId))
    throw policyError('Only accepted campaign owners can view this policy', 403);
  if (required !== undefined) {
    if (userId !== campaign.creator_id)
      throw policyError('Only the campaign creator can change the policy', 403);
    if (!Number.isInteger(required) || required < 0 || required > 10) {
      throw policyError('required_approvals must be an integer between 0 and 10', 400);
    }
    if (required > eligible.size - 1)
      throw policyError('Invite enough owners and have them accept before enabling this policy');
    await client.query(
      'UPDATE campaigns SET withdrawal_team_approvals_required = $1 WHERE id = $2',
      [required, campaignId]
    );
    campaign.withdrawal_team_approvals_required = required;
  }
  return {
    required_approvals: campaign.withdrawal_team_approvals_required,
    eligible_other_owners: eligible.size - 1,
    can_manage: userId === campaign.creator_id,
    can_approve: true,
  };
}

async function loadRequest(client, id) {
  const { rows } = await client.query(
    `SELECT wr.*, c.creator_id FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id WHERE wr.id = $1 FOR UPDATE OF wr, c`,
    [id]
  );
  if (!rows.length) throw policyError('Withdrawal request not found', 404);
  return rows[0];
}

async function approvalState(client, row, userId) {
  const eligible = await owners(client, {
    campaign_id: row.campaign_id,
    creator_id: row.creator_id,
  });
  eligible.delete(row.requested_by);
  const { rows } = await client.query(
    'SELECT user_id, member_id FROM withdrawal_team_approvals WHERE withdrawal_request_id = $1',
    [row.id]
  );
  const valid = rows.filter(
    vote => eligible.has(vote.user_id) && eligible.get(vote.user_id) === vote.member_id
  );
  const approved = valid.some(vote => vote.user_id === userId);
  const required = row.is_refund ? 0 : row.team_approvals_required;
  return {
    required_approvals: required,
    approvals: valid.length,
    satisfied: valid.length >= required,
    approved_by_me: approved,
    can_approve:
      required > 0 &&
      eligible.has(userId) &&
      !approved &&
      row.status === 'pending' &&
      !row.platform_signed &&
      (!row.expires_at || new Date(row.expires_at) > new Date()),
    memberId: eligible.get(userId),
  };
}

async function teamApproval(client, id, userId, approve = false) {
  const row = await loadRequest(client, id);
  const eligible = await owners(client, {
    campaign_id: row.campaign_id,
    creator_id: row.creator_id,
  });
  if (!eligible.has(userId))
    throw policyError('Only accepted campaign owners can view or approve this withdrawal', 403);
  let state = await approvalState(client, row, userId);
  if (approve) {
    if (row.requested_by === userId)
      throw policyError('The requester cannot count toward team approval', 403);
    if (!state.can_approve && !state.approved_by_me)
      throw policyError('This withdrawal cannot accept team approvals');
    if (state.can_approve) {
      await client.query(
        `INSERT INTO withdrawal_team_approvals (withdrawal_request_id, user_id, member_id)
         VALUES ($1, $2, $3) ON CONFLICT (withdrawal_request_id, user_id)
         DO UPDATE SET member_id = EXCLUDED.member_id, created_at = NOW()`,
        [id, userId, state.memberId]
      );
      state = await approvalState(client, row, userId);
    }
  }
  const result = { ...state };
  delete result.memberId;
  return result;
}

async function assertTeamApproved(client, row) {
  // Legacy requests and contributor refunds retain their existing release path.
  if (row.is_refund || !row.team_approvals_required) return;
  const state = await approvalState(client, row);
  if (!state.satisfied)
    throw policyError(
      `Team approval required: ${state.approvals}/${state.required_approvals} owners approved`
    );
}

async function insertWithdrawalRequest(
  client,
  { campaignId, requestedBy, amount, destinationKey, xdr, evidence }
) {
  const { rows } = await client.query(
    `INSERT INTO withdrawal_requests
       (campaign_id, requested_by, amount, destination_key, unsigned_xdr, creator_signed, platform_signed, evidence, team_approvals_required)
     SELECT $1, $2, $3, $4, $5, FALSE, FALSE, $6, c.withdrawal_team_approvals_required
     FROM campaigns c WHERE c.id = $1 FOR SHARE RETURNING *`,
    [campaignId, requestedBy, amount, destinationKey, xdr, JSON.stringify(evidence)]
  );
  if (!rows.length) throw policyError('Campaign not found', 404);
  return rows[0];
}

module.exports = { campaignPolicy, teamApproval, assertTeamApproved, insertWithdrawalRequest };
