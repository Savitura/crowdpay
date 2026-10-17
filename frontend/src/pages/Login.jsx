import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

const styles = {
  container: { paddingTop: '4rem', maxWidth: '400px' },
  heading: { fontSize: '1.6rem', fontWeight: 800, marginBottom: '1.5rem' },
  form: { display: 'flex', flexDirection: 'column', gap: '0.85rem' },
  passwordWrapper: { position: 'relative' },
  passwordInput: { paddingRight: '2.5rem', width: '100%' },
  passwordToggle: {
    position: 'absolute',
    right: '0.6rem',
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#888',
    padding: '0.2rem',
    minHeight: 'auto',
    fontSize: '0.85rem',
  },
  error: { color: 'var(--color-status-error)', fontSize: '0.875rem' },
  submitBtn: { padding: '0.8rem' },
  center: { textAlign: 'center' },
  forgotLink: { color: 'var(--color-text-hint)', fontSize: '0.85rem', textDecoration: 'none' },
  bottomText: { marginTop: '1.25rem', color: 'var(--color-text-hint)', fontSize: '0.9rem' },
  signUpLink: { color: 'var(--color-accent)', fontWeight: 600 },
};

export default function Login() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState(1);
  const [code, setCode] = useState('');

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (step === 1) {
      if (!form.email.trim() || !form.password.trim()) {
        setError(t('login.required'));
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
        setError(t('login.invalidEmail'));
        return;
      }
      setLoading(true);
      setError('');
      try {
        const res = await api.login(form);
        if (res.requires_2fa) {
          setStep(2);
        } else {
          login(res.user);
          navigate(location.state?.from || '/discover', { replace: true });
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    } else {
      if (!code.trim()) {
        setError(t('login.twoFactorRequired'));
        return;
      }
      setLoading(true);
      setError('');
      try {
        const { user } = await api.login2FA({ ...form, code });
        login(user);
        navigate(location.state?.from || '/discover', { replace: true });
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <main className="container" style={styles.container}>
      <h1 style={styles.heading}>{t('login.title')}</h1>
      <form noValidate onSubmit={handleSubmit} style={styles.form}>
        {step === 1 ? (
          <>
            <input
              type="email"
              placeholder={t('login.email')}
              value={form.email}
              onChange={set('email')}
              required
            />
            <div style={styles.passwordWrapper}>
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                placeholder={t('login.password')}
                value={form.password}
                onChange={set('password')}
                required
                style={styles.passwordInput}
                autoComplete="current-password"
              />
              <button
                type="button"
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                onClick={() => setShowPassword((v) => !v)}
                style={styles.passwordToggle}
              >
                {showPassword ? t('common.hide') : t('common.show')}
              </button>
            </div>
          </>
        ) : (
          <input
            type="text"
            placeholder={t('login.twoFactorPlaceholder')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoComplete="one-time-code"
          />
        )}
        {error && <p style={styles.error}>{error}</p>}
        <button type="submit" className="btn-primary" disabled={loading} style={styles.submitBtn}>
          {loading ? t('login.loading') : t('login.submit')}
        </button>
        <div style={styles.center}>
          <Link to="/forgot-password" style={styles.forgotLink}>
            {t('login.forgotPassword')}
          </Link>
        </div>
      </form>
      <p style={styles.bottomText}>
        {t('login.noAccount')}{' '}
        <Link to="/register" style={styles.signUpLink}>
          {t('login.signUp')}
        </Link>
      </p>
    </main>
  );
}
