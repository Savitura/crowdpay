import React, { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  function validatePassword(value) {
    if (value.length < 8) return 'Password must be at least 8 characters long';
    if (!/[a-z]/.test(value)) return 'Password must include a lowercase letter';
    if (!/[A-Z]/.test(value)) return 'Password must include an uppercase letter';
    if (!/[0-9]/.test(value)) return 'Password must include a number';
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== confirmPassword) {
      return setError('Passwords do not match');
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return setError(passwordError);
    }
    
    setLoading(true);
    setError('');
    try {
      await api.resetPassword({ token, password });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <main className="container" style={{ paddingTop: '4rem', maxWidth: '400px' }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1rem' }}>Invalid link</h1>
        <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem' }}>
          This password reset link is invalid or missing a token.
        </p>
        <Link to="/forgot-password" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>Request a new link</Link>
      </main>
    );
  }

  return (
    <main className="container" style={{ paddingTop: '4rem', maxWidth: '400px' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.5rem' }}>Reset password</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Enter your new password below.
      </p>

      {success ? (
        <div style={{ padding: '1rem', backgroundColor: 'var(--color-success-bg)', color: 'var(--color-success-text)', borderRadius: '0.5rem', fontSize: '0.9rem', marginBottom: '1.5rem', border: '1px solid var(--color-success-border)' }}>
          Password reset successfully! Redirecting to login...
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <input 
            type="password" 
            placeholder="New password" 
            value={password} 
            onChange={(e) => setPassword(e.target.value)} 
            required 
            minLength={8}
          />
          <input 
            type="password" 
            placeholder="Confirm new password" 
            value={confirmPassword} 
            onChange={(e) => setConfirmPassword(e.target.value)} 
            required 
            minLength={8}
          />
          {error && <p style={{ color: 'var(--color-status-error)', fontSize: '0.875rem' }}>{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading} style={{ padding: '0.8rem' }}>
            {loading ? 'Resetting password…' : 'Reset password'}
          </button>
        </form>
      )}
    </main>
  );
}
