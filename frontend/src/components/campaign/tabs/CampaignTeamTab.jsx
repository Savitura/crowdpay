import React from 'react';
import TeamCampaignsSection from '../../TeamCampaignsSection';

export default function CampaignTeamTab({
  campaign,
  isOwner = false,
  canChangeRoles = false,
  user = null,
  inviteForm = { email: '', role: 'viewer' },
  setInviteForm,
  inviteBusy = false,
  inviteError = '',
  inviteSuccess = false,
  handleInviteSubmit,
  pendingInvites = [],
  acceptedMembers = [],
  handleResendInvite,
  handleCancelInvite,
  handleRoleChange,
  handleRemoveMember,
}) {
  if (!campaign) return null;

  return (
    <div style={{ marginBottom: '2rem' }} data-no-print>
      <h2 style={styles.sectionTitle}>Team</h2>

      {/* Team fundraising pages (#952): aggregated member campaigns */}
      <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
        <strong style={{ display: 'block', marginBottom: '0.75rem' }}>Fundraising teams</strong>
        <TeamCampaignsSection campaignId={campaign.id} canManage={isOwner} />
      </div>

      <div className="campaign-card" style={{ marginBottom: '1.5rem', fontSize: '0.85rem' }}>
        <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Role permissions</strong>
        <ul style={{ margin: 0, paddingLeft: '1.1rem', color: 'var(--color-text-hint)' }}>
          <li>
            <strong>Owner</strong> - full control: manage team, assign roles (including owner), edit
            content, post updates, withdraw funds.
          </li>
          <li>
            <strong>Manager</strong> - invite members, post updates, submit milestones, view
            analytics.
          </li>
          <li>
            <strong>Editor</strong> - edit campaign content.
          </li>
          <li>
            <strong>Viewer</strong> - read-only access to analytics.
          </li>
        </ul>
      </div>

      <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
        <strong style={{ marginBottom: '0.75rem', display: 'block' }}>Invite Team Member</strong>
        <form
          onSubmit={handleInviteSubmit}
          style={{
            display: 'flex',
            gap: '0.75rem',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          <div style={{ flex: '1 1 250px' }}>
            <label
              style={{
                fontSize: '0.85rem',
                color: 'var(--color-text-hint)',
                display: 'block',
                marginBottom: '0.25rem',
              }}
            >
              Email
            </label>
            <input
              type="email"
              placeholder="member@example.com"
              value={inviteForm.email}
              onChange={(e) => setInviteForm?.((s) => ({ ...s, email: e.target.value }))}
              required
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ width: '140px' }}>
            <label
              style={{
                fontSize: '0.85rem',
                color: 'var(--color-text-hint)',
                display: 'block',
                marginBottom: '0.25rem',
              }}
            >
              Role
            </label>
            <select
              value={inviteForm.role}
              onChange={(e) => setInviteForm?.((s) => ({ ...s, role: e.target.value }))}
              style={{ width: '100%', padding: '0.5rem' }}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="manager">Manager</option>
              {canChangeRoles && <option value="owner">Owner</option>}
            </select>
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={inviteBusy}
            style={{ height: '38px' }}
          >
            {inviteBusy ? 'Sending...' : 'Invite'}
          </button>
        </form>
        {inviteError && (
          <p className="alert alert--error" style={{ marginTop: '0.75rem' }}>
            {inviteError}
          </p>
        )}
        {inviteSuccess && (
          <p className="alert alert--success" style={{ marginTop: '0.75rem' }}>
            Invitation sent!
          </p>
        )}
      </div>

      {pendingInvites.length > 0 && (
        <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
          <strong style={{ marginBottom: '0.75rem', display: 'block' }}>Pending Invitations</strong>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {pendingInvites.map((member) => (
              <div
                key={member.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '1rem',
                  flexWrap: 'wrap',
                  borderBottom: '1px solid var(--color-border-lighter)',
                  paddingBottom: '0.5rem',
                }}
              >
                <div>
                  <span style={{ fontWeight: 600 }}>{member.email}</span>
                  <span
                    style={{
                      marginLeft: '0.5rem',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: 'var(--color-warning-text)',
                      background: 'var(--color-warning-bg)',
                      padding: '0.15rem 0.45rem',
                      borderRadius: '4px',
                    }}
                  >
                    {member.role}
                  </span>
                  {member.invite_expires_at && (
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--color-text-hint)',
                        marginTop: '0.25rem',
                      }}
                    >
                      Expires {new Date(member.invite_expires_at).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleResendInvite && handleResendInvite(member.id)}
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
                  >
                    Resend
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleCancelInvite && handleCancelInvite(member.id)}
                    style={{
                      padding: '0.25rem 0.5rem',
                      fontSize: '0.85rem',
                      color: 'var(--color-status-error)',
                      borderColor: 'var(--color-status-error)',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="campaign-card">
        <strong style={{ marginBottom: '0.75rem', display: 'block' }}>Team Members</strong>
        {acceptedMembers.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)' }}>No accepted team members yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {acceptedMembers.map((member) => (
              <div
                key={member.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '1rem',
                  borderBottom: '1px solid var(--color-border-lighter)',
                  paddingBottom: '0.5rem',
                }}
              >
                <div>
                  <span style={{ fontWeight: 600 }}>{member.email}</span>
                  {member.user_name && (
                    <span
                      style={{
                        color: 'var(--color-text-hint)',
                        fontSize: '0.85rem',
                        marginLeft: '0.5rem',
                      }}
                    >
                      ({member.user_name})
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: '0.5rem',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: 'var(--color-accent)',
                      background: 'var(--color-accent-bg, rgba(99,102,241,0.1))',
                      padding: '0.15rem 0.45rem',
                      borderRadius: '4px',
                    }}
                  >
                    {member.role}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'center',
                  }}
                >
                  {canChangeRoles && member.user_id ? (
                    <select
                      value={member.role}
                      onChange={(e) =>
                        handleRoleChange && handleRoleChange(member.user_id, e.target.value)
                      }
                      disabled={String(member.user_id) === String(user?.id)}
                      style={{ padding: '0.25rem', fontSize: '0.85rem' }}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="manager">Manager</option>
                      <option value="owner">Owner</option>
                    </select>
                  ) : (
                    <span style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
                      {member.role}
                    </span>
                  )}
                  {(canChangeRoles || String(member.user_id) === String(user?.id)) &&
                    member.user_id && (
                      <button
                        className="btn-secondary"
                        onClick={() => handleRemoveMember && handleRemoveMember(member.user_id)}
                        disabled={
                          canChangeRoles &&
                          String(member.user_id) === String(user?.id) &&
                          member.role === 'owner'
                        }
                        style={{
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.85rem',
                          color: 'var(--color-status-error)',
                          borderColor: 'var(--color-status-error)',
                        }}
                      >
                        {String(member.user_id) === String(user?.id) ? 'Leave' : 'Remove'}
                      </button>
                    )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  sectionTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
};
