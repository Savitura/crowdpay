/* eslint-disable */
import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { api } from '../services/api';
import NotificationDropdown from './NotificationDropdown';
import Logo from './Logo';

const NAV_LINKS = [
  { to: '/discover', labelKey: 'nav.discover', fallback: 'Discover' },
  { to: '/discover', labelKey: 'nav.supportSpaces', fallback: 'Support Spaces' },
  { to: '/how-it-works', labelKey: 'nav.howItWorks', fallback: 'How It Works' },
  { to: '/pricing', labelKey: 'nav.pricing', fallback: 'Pricing' },
  { to: '/about', labelKey: 'nav.about', fallback: 'About Us' },
];

export default function Navbar() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { dark, toggleTheme } = useTheme();
  const language = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];

  const [notifications, setNotifications] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const bellRef = useRef(null);

  const unread = notifications.filter((n) => !n.read_at).length;

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      return;
    }
    const fetchNotifs = () =>
      api
        .getNotifications()
        .then(setNotifications)
        .catch(() => {});
    fetchNotifs();
    const id = setInterval(fetchNotifs, 30_000);
    return () => clearInterval(id);
  }, [user]);

  useEffect(() => {
    if (!showDropdown) return;
    function handleOutside(e) {
      if (bellRef.current && !bellRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [showDropdown]);

  async function handleMarkRead(id) {
    try {
      await api.markNotificationRead(id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
      );
    } catch (_err) {
      /* ignore */
    }
  }

  async function handleMarkAllRead() {
    try {
      await api.markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read_at: new Date().toISOString() })));
    } catch (_err) {
      /* ignore */
    }
  }

  async function handleLogout() {
    await logout();
    navigate('/');
  }

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  return (
    <nav style={styles.nav} data-no-print>
      <div className="container nav-inner-wrap">
        <Link
          to="/"
          style={styles.logo}
          aria-label={t('nav.homeAria')}
          aria-current={pathname === '/' ? 'page' : undefined}
        >
          <Logo size={32} />
        </Link>
        <button
          type="button"
          className="nav-hamburger"
          onClick={() => setMobileMenuOpen((v) => !v)}
          aria-label={t('nav.toggleMenu', 'Toggle menu')}
          aria-expanded={mobileMenuOpen}
        >
          {mobileMenuOpen ? '✕' : '☰'}
        </button>
        <div className={`nav-links${mobileMenuOpen ? ' nav-links--open' : ''}`}>
          <div style={styles.centerLinks}>
            {NAV_LINKS.map((item) => (
              <Link
                key={item.labelKey}
                to={item.to}
                style={styles.link}
                aria-current={pathname === item.to ? 'page' : undefined}
              >
                {t(item.labelKey, item.fallback)}
              </Link>
            ))}
          </div>

          <div className="nav-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-hint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input type="search" placeholder={t('nav.searchPlaceholder', 'Search projects, people, causes...')} aria-label={t('nav.searchPlaceholder')} />
            <span className="nav-search__kbd" aria-hidden="true">⌘ K</span>
          </div>

          <div style={styles.navRight}>
            <select
              value={language}
              onChange={(e) => i18n.changeLanguage(e.target.value)}
              aria-label={t('nav.selectLanguage')}
              style={styles.languageSelect}
            >
              <option value="en">EN</option>
              <option value="fr">FR</option>
            </select>

            <button
              type="button"
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={t('nav.toggleTheme', 'Toggle theme')}
            >
              {dark ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.2" y1="4.2" x2="5.6" y2="5.6" /><line x1="18.4" y1="18.4" x2="19.8" y2="19.8" />
                  <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.2" y1="19.8" x2="5.6" y2="18.4" /><line x1="18.4" y1="5.6" x2="19.8" y2="4.2" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
                </svg>
              )}
            </button>

            {user ? (
              <>
                <div style={styles.bellWrap} ref={bellRef}>
                  <button
                    onClick={() => setShowDropdown((v) => !v)}
                    className="icon-btn"
                    style={{ position: 'relative' }}
                    aria-label={`${unread} unread notifications`}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                    </svg>
                    {unread > 0 && <span style={styles.badge}>{unread}</span>}
                  </button>
                  {showDropdown && (
                    <NotificationDropdown
                      notifications={notifications}
                      onMarkRead={handleMarkRead}
                      onMarkAllRead={handleMarkAllRead}
                      onClose={() => setShowDropdown(false)}
                    />
                  )}
                </div>
                <Link to="/campaigns/new">
                  <button className="btn-accent" style={styles.ctaBtn}>
                    + {t('nav.createSupportSpace', 'Create Support Space')}
                  </button>
                </Link>
                <div style={styles.avatarWrap}>
                  <div style={styles.avatar} aria-hidden="true">
                    {user.name ? user.name.charAt(0).toUpperCase() : '?'}
                  </div>
                  <span style={styles.name}>{user.name}</span>
                </div>
                <button onClick={handleLogout} className="btn-secondary" style={styles.logoutBtn}>
                  {t('nav.logout')}
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  style={styles.loginLink}
                  aria-current={pathname === '/login' ? 'page' : undefined}
                >
                  {t('nav.login')}
                </Link>
                <Link to="/register" aria-current={pathname === '/register' ? 'page' : undefined}>
                  <button className="btn-accent" style={styles.ctaBtn}>
                    {t('nav.signup', 'Sign up')}
                  </button>
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}

const styles = {
  nav: {
    background: 'var(--color-bg)',
    borderBottom: '1px solid var(--color-border-light)',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  centerLinks: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.5rem',
    flexWrap: 'wrap',
  },
  link: {
    color: 'var(--color-text-secondary)',
    fontWeight: 500,
    fontSize: '0.9rem',
    transition: 'color 0.15s',
  },
  name: {
    color: 'var(--color-text-primary)',
    fontSize: '0.85rem',
    fontWeight: 600,
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  avatarWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  avatar: {
    width: '34px',
    height: '34px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #4f83f1 0%, #1d4ed8 100%)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.85rem',
    fontWeight: 700,
    flexShrink: 0,
  },
  languageSelect: {
    width: 'auto',
    background: 'transparent',
    border: '1px solid var(--color-border)',
    borderRadius: '6px',
    padding: '0.3rem 0.5rem',
    color: 'var(--color-text-secondary)',
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  navRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  loginLink: {
    color: 'var(--color-text-primary)',
    fontWeight: 500,
    fontSize: '0.9rem',
  },
  ctaBtn: {
    padding: '0.5rem 1.1rem',
    fontSize: '0.85rem',
    borderRadius: '8px',
    whiteSpace: 'nowrap',
  },
  logoutBtn: {
    padding: '0.4rem 0.9rem',
    fontSize: '0.85rem',
  },
  bellWrap: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: '0',
    right: '0',
    background: '#ef4444',
    color: '#fff',
    fontSize: '0.65rem',
    fontWeight: 700,
    borderRadius: '99px',
    padding: '1px 5px',
    lineHeight: 1.3,
  },
};
