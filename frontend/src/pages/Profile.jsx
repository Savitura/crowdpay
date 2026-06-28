import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { stellarExpertAccountUrl } from '../config/stellar';
import VerificationBadge from '../components/VerificationBadge';
import KycPrompt from '../components/KycPrompt';
import { api } from '../services/api';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE_URL = import.meta.env.VITE_API_URL || `${API_BASE_URL}/api`;

export default function Profile() {
  const { user, token, ready, updateUser } = useAuth();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [copied, setCopied] = useState(false);

  const [setupStep, setSetupStep] = useState(0); // 0: initial, 1: showing QR, 2: confirmed
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [backupCodes, setBackupCodes] = useState([]);
  const [twoFaError, setTwoFaError] = useState('');
  const [twoFaLoading, setTwoFaLoading] = useState(false);

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
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: name.trim() }),
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

  const handleStart2FA = async () => {
    setTwoFaLoading(true);
    setTwoFaError('');
    try {
      const res = await api.setup2FA();
      setQrCodeDataUrl(res.qrCodeDataUrl);
      setTotpSecret(res.secret);
      setSetupStep(1);
    } catch (err) {
      setTwoFaError(err.message);
    } finally {
      setTwoFaLoading(false);
    }
  };

  const handleVerify2FA = async (e) => {
    e.preventDefault();
    if (!totpCode.trim()) return;
    setTwoFaLoading(true);
    setTwoFaError('');
    try {
      const res = await api.verify2FA({ code: totpCode });
      setBackupCodes(res.backupCodes);
      setSetupStep(2);
      if (updateUser) updateUser({ ...user, totp_enabled: true });
    } catch (err) {
      setTwoFaError(err.message);
    } finally {
      setTwoFaLoading(false);
    }
  };

  const kycRequired =
    user?.kyc_required_for_campaigns ??
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false';

  const kycStatus = user?.kyc_status || 'unverified';

  return (
    <main className="container page-narrow" style={{ paddingTop: '3rem', paddingBottom: '4rem' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '1.5rem' }}>Your Profile</h1>

      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '1rem' }}>
          Account details
        </h2>

        {error && (
          <p className="alert alert--error" style={{ marginBottom: '1rem' }}>
            {error}
          </p>
        )}
        {success && (
          <p className="alert alert--success" style={{ marginBottom: '1rem' }}>
            {success}
          </p>
        )}

        <form onSubmit={handleSave}>
          <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
            <label htmlFor="profile-name" className="label-strong">
              Display name
            </label>
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
              style={{
                background: 'var(--color-surface)',
                color: 'var(--color-text-secondary)',
                cursor: 'not-allowed',
              }}
            />
          </div>

          <div className="form-stack" style={{ marginBottom: '1.5rem' }}>
            <label className="label-strong">Member since</label>
            <input
              value={user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}
              disabled
              style={{
                background: 'var(--color-surface)',
                color: 'var(--color-text-secondary)',
                cursor: 'not-allowed',
              }}
            />
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={saving || !name.trim() || name === user.name}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </div>

      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: '0.75rem',
          }}
        >
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>Identity verification</h2>
          <VerificationBadge status={kycStatus} />
        </div>

        {kycStatus === 'verified' && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', margin: 0 }}>
            Your identity is verified
            {user.kyc_completed_at
              ? ` as of ${new Date(user.kyc_completed_at).toLocaleDateString()}`
              : ''}
            .
          </p>
        )}

        {kycStatus === 'pending' && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', margin: 0 }}>
            Verification is in progress. Reviews typically complete within a few minutes.
          </p>
        )}

        {kycStatus === 'rejected' && kycRequired && (
          <div>
            <p className="alert alert--error" style={{ marginBottom: '0.75rem' }}>
              Verification was not approved. You can submit again with updated documents.
            </p>
            <KycPrompt onUserUpdate={updateUser} title="Try identity verification again" />
          </div>
        )}

        {kycStatus === 'unverified' && kycRequired && (
          <KycPrompt onUserUpdate={updateUser} title="Verify your identity" />
        )}
      </div>

      <div className="campaign-card">
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>
          Your Stellar wallet
        </h2>
        <p
          style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}
        >
          This is a custodial wallet managed by CrowdPay.
        </p>

        <div
          style={{
            background: 'var(--color-surface)',
            padding: '1rem',
            borderRadius: '8px',
            marginBottom: '1rem',
          }}
        >
          <code style={{ wordBreak: 'break-all', color: 'var(--color-text-primary)' }}>
            {user.wallet_public_key}
          </code>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy address'}
          </button>
          {typeof stellarExpertAccountUrl === 'function' && (
            <a
              href={stellarExpertAccountUrl(user.wallet_public_key)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
            >
              View on Stellar Expert ↗
            </a>
          )}
        </div>
      </div>

      {(user?.role === 'creator' || user?.role === 'admin') && (
        <div className="campaign-card">
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            Security Settings
          </h2>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Protect your account with Two-Factor Authentication (TOTP).
          </p>

          {user.totp_enabled ? (
            <p className="alert alert--success">Two-Factor Authentication is enabled on this account.</p>
          ) : (
            <>
              {twoFaError && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{twoFaError}</p>}
              
              {setupStep === 0 && (
                <button className="btn-primary" onClick={handleStart2FA} disabled={twoFaLoading}>
                  {twoFaLoading ? 'Setting up...' : 'Setup 2FA'}
                </button>
              )}

              {setupStep === 1 && (
                <div style={{ background: 'var(--color-surface)', padding: '1rem', borderRadius: '8px' }}>
                  <p>1. Scan this QR code with your Authenticator app (like Google Authenticator or Authy):</p>
                  <img src={qrCodeDataUrl} alt="2FA QR Code" style={{ display: 'block', margin: '1rem 0' }} />
                  <p>Or enter this secret manually: <strong>{totpSecret}</strong></p>
                  <form onSubmit={handleVerify2FA} style={{ marginTop: '1rem' }}>
                    <div className="form-stack">
                      <label className="label-strong">2. Enter the 6-digit code from your app</label>
                      <input 
                        type="text" 
                        value={totpCode} 
                        onChange={(e) => setTotpCode(e.target.value)} 
                        placeholder="000000" 
                        required 
                      />
                    </div>
                    <button type="submit" className="btn-primary" disabled={twoFaLoading} style={{ marginTop: '1rem' }}>
                      {twoFaLoading ? 'Verifying...' : 'Verify and Enable'}
                    </button>
                  </form>
                </div>
              )}

              {setupStep === 2 && (
                <div className="alert alert--info">
                  <h3 style={{ marginTop: 0 }}>2FA Enabled Successfully!</h3>
                  <p>Please save these backup codes in a secure location. You will not see them again.</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '1rem' }}>
                    {backupCodes.map((code, idx) => (
                      <code key={idx} style={{ background: '#fff', padding: '0.25rem 0.5rem', borderRadius: '4px', textAlign: 'center' }}>{code}</code>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}
