import React, { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { stellarExpertAccountUrl } from '../config/stellar';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE_URL = import.meta.env.VITE_API_URL || `${API_BASE_URL}/api`;

export default function Profile() {
  const { user, token, ready, updateUser } = useAuth();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name || '');
    }
  }, [user]);

  if (!ready) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Loading session…</p>
      </main>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Display name is required');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`${BASE_URL}/users/me`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name: name.trim() })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update profile');
      }
      const updatedUser = await res.json();
      if (updateUser) updateUser(updatedUser);
      setSuccess('Profile updated successfully');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(user.wallet_public_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main className="container page-narrow" style={{ paddingTop: '3rem', paddingBottom: '4rem' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '1.5rem' }}>Your Profile</h1>
      
      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '1rem' }}>Account details</h2>
        
        {error && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{error}</p>}
        {success && <p className="alert alert--success" style={{ marginBottom: '1rem' }}>{success}</p>}
        
        <form onSubmit={handleSave}>
          <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
            <label htmlFor="profile-name" className="label-strong">Display name</label>
            <input 
              id="profile-name" 
              value={name} 
              onChange={(e) => setName(e.target.value)} 
              placeholder="Your display name"
            />
          </div>
          
          <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
            <label className="label-strong">Email address</label>
            <input 
              value={user.email || ''} 
              disabled 
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)', cursor: 'not-allowed' }} 
            />
          </div>
          
          <div className="form-stack" style={{ marginBottom: '1.5rem' }}>
            <label className="label-strong">Member since</label>
            <input 
              value={user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'} 
              disabled 
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)', cursor: 'not-allowed' }} 
            />
          </div>
          
          <button type="submit" className="btn-primary" disabled={saving || !name.trim() || name === user.name}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </div>

      <div className="campaign-card">
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>Your Stellar wallet</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          This is a custodial wallet managed by CrowdPay.
        </p>
        
        <div style={{ background: 'var(--color-surface)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem' }}>
          <code style={{ wordBreak: 'break-all', color: 'var(--color-text-primary)' }}>
            {user.wallet_public_key}
          </code>
        </div>
        
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy address'}
          </button>
          {typeof stellarExpertAccountUrl === 'function' && (
            <a href={stellarExpertAccountUrl(user.wallet_public_key)} target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
              View on Stellar Expert ↗
            </a>
          )}
        </div>
      </div>
    </main>
  );
}