import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import RelativeTime from '../RelativeTime';
import { badgeStyle, cardStyle } from './AdminShared';

export default function KycOversight() {
  const { updateUser } = useAuth();
  const navigate = useNavigate();
  const [kycFilter, setKycFilter] = useState('pending');
  const [users, setUsers] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.getAdminUsers({ kyc_status: kycFilter }), api.getAdminKycCampaigns()])
      .then(([u, c]) => {
        setUsers(u);
        setCampaigns(c);
      })
      .finally(() => setLoading(false));
  }, [kycFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function overrideKyc(userId, kyc_status) {
    const reason = window.prompt(`Reason for marking as ${kyc_status}:`, '');
    if (reason === null) return;
    setBusyId(userId);
    try {
      await api.adminUpdateUserKyc(userId, { kyc_status, reason: reason || undefined });
      load();
    } catch (err) {
      alert(err.message || 'KYC update failed');
    } finally {
      setBusyId(null);
    }
  }

  async function impersonateUser(user) {
    setBusyId(user.id);
    try {
      await api.adminImpersonateUser(user.id);
      const userData = await api.getMe();
      updateUser(userData);
      navigate('/dashboard');
    } catch (err) {
      alert(err.message || 'Could not start impersonation');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading KYC data…</p>;

  return (
    <div style={{ display: 'grid', gap: '1.5rem', marginBottom: '2rem' }}>
      <div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          {['pending', 'verified', 'rejected', 'unverified'].map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setKycFilter(status)}
              style={{
                ...badgeStyle,
                cursor: 'pointer',
                opacity: kycFilter === status ? 1 : 0.6,
                border:
                  kycFilter === status ? '1px solid var(--color-accent)' : '1px solid transparent',
              }}
            >
              {status}
            </button>
          ))}
        </div>

        {users.length === 0 ? (
          <p style={{ color: 'var(--color-text-hint)' }}>
            No users with status &ldquo;{kycFilter}&rdquo;.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            {users.map((u) => (
              <div
                key={u.id}
                style={{
                  ...cardStyle,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <strong>{u.name}</strong> — {u.email}
                  <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                    KYC: {u.kyc_status}
                    {u.kyc_completed_at && (
                      <>
                        {' '}
                        · verified <RelativeTime date={u.kyc_completed_at} />
                      </>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={busyId === u.id}
                    onClick={() => impersonateUser(u)}
                    style={{ fontSize: '0.75rem' }}
                  >
                    View as user
                  </button>
                  {u.kyc_status !== 'verified' && (
                    <button
                      type="button"
                      disabled={busyId === u.id}
                      onClick={() => overrideKyc(u.id, 'verified')}
                      style={{ fontSize: '0.75rem' }}
                    >
                      Mark verified
                    </button>
                  )}
                  {u.kyc_status === 'verified' && (
                    <button
                      type="button"
                      disabled={busyId === u.id}
                      onClick={() => overrideKyc(u.id, 'unverified')}
                      style={{ fontSize: '0.75rem' }}
                    >
                      Force re-verification
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
          Campaigns with KYC-unverified contributors
        </h3>
        {campaigns.length === 0 ? (
          <p style={{ color: 'var(--color-text-hint)' }}>None found.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {campaigns.map((c) => (
              <li key={c.id} style={{ marginBottom: '0.35rem' }}>
                {c.title} — {c.unverified_contributor_count} unverified contributor
                {c.unverified_contributor_count !== 1 ? 's' : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
