import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function AcceptInvite() {
  const { id, token } = useParams();
  const { user, token: authToken, ready } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleAccept() {
    setLoading(true);
    setError('');
    try {
      await api.acceptCampaignInvitation(id, { token }, authToken);
      setSuccess(true);
      setLoading(false);
      setTimeout(() => {
        navigate(`/campaigns/${id}`);
      }, 2000);
    } catch (err) {
      setError(err.message || 'Could not accept invitation.');
      setLoading(false);
    }
  }

  if (!ready) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Loading session…</p>
      </main>
    );
  }

  if (!authToken) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '1rem' }}>Join Campaign Team</h1>
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

  return (
    <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '1rem' }}>Accept Campaign Invitation</h1>
      {success ? (
        <p className="alert alert--success">
          <strong>Invitation accepted!</strong> You are now a member of the campaign team. Redirecting…
        </p>
      ) : (
        <>
          <p style={{ color: '#555', marginBottom: '1.5rem', lineHeight: 1.55 }}>
            You have been invited to participate in this crowdfunding project. Accepting gives you access to the campaign permissions granted to your account.
          </p>
          {error && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{error}</p>}
          <button className="btn-primary" disabled={loading} onClick={handleAccept} style={{ width: '100%' }}>
            {loading ? 'Accepting…' : 'Accept Invitation'}
          </button>
        </>
      )}
    </main>
  );
}
