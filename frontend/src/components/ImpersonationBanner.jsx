import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ImpersonationBanner() {
  const { user, exitImpersonation } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  if (!user?.impersonation?.active) return null;

  async function handleExit() {
    setBusy(true);
    try {
      await exitImpersonation();
      navigate('/admin');
    } catch (err) {
      alert(err.message || 'Could not exit impersonation mode');
    } finally {
      setBusy(false);
    }
  }

  const displayName = user.name || user.email || user.id;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        flexWrap: 'wrap',
        padding: '0.7rem 1rem',
        background: '#fff4cc',
        color: '#5f3d00',
        borderBottom: '1px solid #f0c45c',
        fontSize: '0.9rem',
        fontWeight: 600,
      }}
    >
      <span>You are viewing as {displayName}</span>
      <button
        type="button"
        onClick={handleExit}
        disabled={busy}
        style={{
          border: '1px solid #b98209',
          borderRadius: '6px',
          background: '#fff',
          color: '#5f3d00',
          cursor: busy ? 'not-allowed' : 'pointer',
          fontSize: '0.85rem',
          fontWeight: 700,
          padding: '0.35rem 0.7rem',
        }}
      >
        {busy ? 'Exiting...' : 'Exit impersonation'}
      </button>
    </div>
  );
}
