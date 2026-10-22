import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

export default function WithdrawalTeamApprovals({ campaignId, token, assetType }) {
  const [policy, setPolicy] = useState(null);
  const [required, setRequired] = useState(0);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const next = await api.getWithdrawalTeamPolicy(campaignId, token);
      setPolicy(next);
      setRequired(next.required_approvals);
      const list = await api.listTeamWithdrawalRequests(campaignId, token);
      const pending = list.data.filter(
        (row) => row.status === 'pending' && row.team_approvals_required > 0
      );
      setRequests(
        await Promise.all(
          pending.map(async (row) => ({
            ...row,
            approval: await api.getWithdrawalTeamApprovals(row.id, token),
          }))
        )
      );
      setError('');
    } catch (err) {
      if ((err.status ?? err.response?.status) === 403) {
        setPolicy(null);
        return;
      }
      setError(err.response?.data?.error || err.message || 'Could not load team approvals.');
    }
  }, [campaignId, token]);
  useEffect(() => {
    if (token) refresh();
  }, [token, refresh]);

  async function perform(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Approval update failed.');
    } finally {
      setBusy(false);
    }
  }
  if (!token || (!policy && !error)) return null;
  return (
    <section aria-label="Withdrawal team approvals" className="card" data-no-print>
      <h2>Withdrawal team approvals</h2>
      {error && <p role="alert">{error}</p>}
      {policy && (
        <>
          <p>
            Require other accepted campaign owners to approve each manual withdrawal before platform
            release. The requester cannot approve their own request. Creator and platform signatures
            are still required.
          </p>
          {policy.can_manage ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                perform(() => api.setWithdrawalTeamPolicy(campaignId, required, token));
              }}
            >
              <label htmlFor={`team-quorum-${campaignId}`}>
                Other owner approvals required (0 disables)
              </label>
              <input
                id={`team-quorum-${campaignId}`}
                type="number"
                min="0"
                max={Math.min(10, policy.eligible_other_owners)}
                required
                value={required}
                onChange={(event) =>
                  setRequired(event.target.value === '' ? '' : Number(event.target.value))
                }
              />
              <button type="submit" disabled={busy}>
                Save approval policy
              </button>
              <p>
                Changes apply to new requests only. Pending requests keep their original
                requirement. Invite owners and have them accept before increasing the requirement.
              </p>
            </form>
          ) : (
            <p>New withdrawals require {policy.required_approvals} other owner approvals.</p>
          )}
          <button type="button" disabled={busy} onClick={() => perform(async () => {})}>
            Refresh team approvals
          </button>
          {requests.map((row) => (
            <article key={row.id}>
              <h3>
                Withdrawal {row.amount} {assetType}
              </h3>
              <p>
                Destination: <code style={{ overflowWrap: 'anywhere' }}>{row.destination_key}</code>
              </p>
              <p>Evidence: {(row.evidence || []).join(', ') || 'No evidence provided'}</p>
              <p role="status">
                {row.approval.approvals} / {row.approval.required_approvals} owner approvals
              </p>
              {row.approval.approved_by_me && <p>You approved this request.</p>}
              {row.approval.can_approve && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => perform(() => api.approveWithdrawalTeam(row.id, token))}
                >
                  Approve this withdrawal
                </button>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
