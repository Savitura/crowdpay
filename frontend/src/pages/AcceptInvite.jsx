import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  editor: 'Editor',
  viewer: 'Viewer',
};

export default function AcceptInvite() {
  const { id, token } = useParams();
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) return;
    setPreviewLoading(true);
    api
      .getInvitePreview(token)
      .then(setPreview)
      .catch((err) => setError(err.message || 'Invitation not found'))
      .finally(() => setPreviewLoading(false));
  }, [token]);

  async function handleAccept() {
    setLoading(true);
    setError('');
    try {
      await api.acceptInviteByToken(token);
      setSuccess(true);
      setLoading(false);
      const campaignId = preview?.campaign_id || id;
      setTimeout(() => {
        navigate(`/campaigns/${campaignId}`);
      }, 2000);
    } catch (err) {
      setError(err.message || 'Could not accept invitation.');
      setLoading(false);
    }
  }

  if (!ready || previewLoading) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Loading invitation…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '1rem' }}>Join Campaign Team</h1>
        {preview && (
          <div className="campaign-card" style={{ marginBottom: '1.25rem' }}>
            <p style={{ margin: 0, fontWeight: 600 }}>{preview.campaign_title}</p>
            <p style={{ margin: '0.35rem 0 0', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }}>
              Role: <strong>{ROLE_LABELS[preview.role] || preview.role}</strong>
            </p>
          </div>
        )}
        <p className="alert alert--warning" style={{ marginBottom: '1.25rem' }}>
          You must be logged in to accept a campaign invitation.
        </p>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <Link to="/login" className="btn-primary" style={{ textDecoration: 'none', padding: '0.75rem 1.25rem' }}>
            Log in
          </Link>
          <Link to="/register" className="btn-secondary" style={{ textDecoration: 'none', padding: '0.75rem 1.25rem' }}>
            Create account
          </Link>
        </div>
      </main>
    );
  }

  if (error && !preview) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '1rem' }}>Invitation unavailable</h1>
        <p className="alert alert--error">{error}</p>
        <Link to="/" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>← Back home</Link>
      </main>
    );
  }

  return (
    <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '1rem' }}>Accept Campaign Invitation</h1>
      {preview && (
        <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>Campaign</p>
          <p style={{ margin: '0.25rem 0 0', fontSize: '1.1rem', fontWeight: 700 }}>{preview.campaign_title}</p>
          <p style={{ margin: '0.75rem 0 0', fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>Your role</p>
          <p style={{ margin: '0.25rem 0 0', fontWeight: 600 }}>{ROLE_LABELS[preview.role] || preview.role}</p>
          {preview.invite_expires_at && (
            <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
              Expires {new Date(preview.invite_expires_at).toLocaleString()}
            </p>
          )}
        </div>
      )}
      {success ? (
        <p className="alert alert--success">
          <strong>Invitation accepted!</strong> You are now a member of the campaign team. Redirecting…
        </p>
      ) : (
        <>
          <p style={{ color: 'var(--color-text-secondary)', marginBottom: '1.5rem', lineHeight: 1.55 }}>
            Accepting grants you the permissions for your assigned role on this campaign.
          </p>
          {error && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{error}</p>}
          <button className="btn-primary" disabled={loading || preview?.expired} onClick={handleAccept} style={{ width: '100%' }}>
            {loading ? 'Accepting…' : preview?.expired ? 'Invitation expired' : 'Accept Invitation'}
          </button>
        </>
      )}
    </main>
  );
}
