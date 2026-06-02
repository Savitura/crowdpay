import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { api } from '../services/api';
import NotificationDropdown from './NotificationDropdown';

export default function Navbar() {
  const { user, logout } = useAuth();
  const { dark, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [notifications, setNotifications] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const bellRef = useRef(null);

  const unread = notifications.filter((n) => !n.read_at).length;

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      return;
    }
    const fetchNotifs = () => api.getNotifications().then(setNotifications).catch(() => {});
    fetchNotifs();
    const id = setInterval(fetchNotifs, 30_000);
    return () => clearInterval(id);
  }, [user]);

  // Close dropdown when clicking outside
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

  function handleLogout() {
    logout();
    navigate('/');
  }

  function handleMarkRead(id) {
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
  }

  async function handleMarkAllRead() {
    await api.markAllNotificationsRead().catch(() => {});
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
  }

  return (
    <nav style={styles.nav}>
      <div className="container nav-inner-wrap">
        <Link to="/" style={styles.logo} aria-label="CrowdPay home" aria-current={pathname === '/' ? 'page' : undefined}>CrowdPay</Link>
        <div className="nav-links">
          {user ? (
            <>
              <Link to="/campaigns/new" style={styles.link} aria-current={pathname === '/campaigns/new' ? 'page' : undefined}>Start Campaign</Link>
              <span style={styles.name} aria-hidden="true">{user.name}</span>
              <div style={styles.bellWrap} ref={bellRef}>
                <button
                  onClick={() => setShowDropdown((v) => !v)}
                  style={styles.bellBtn}
                  aria-label={`${unread} unread notifications`}
                >
                  🔔
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
              <button onClick={handleLogout} className="btn-secondary" style={{ padding: '0.4rem 0.9rem' }}>
                Logout
              </button>
            </>
          ) : (
            <>
              <Link to="/login" style={styles.link} aria-current={pathname === '/login' ? 'page' : undefined}>Log in</Link>
              <Link to="/register" aria-current={pathname === '/register' ? 'page' : undefined}>
                <button className="btn-primary" style={{ padding: '0.4rem 0.9rem' }}>Sign up</button>
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

const styles = {
  nav: { background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)', position: 'sticky', top: 0, zIndex: 10 },
  logo: { fontWeight: 800, fontSize: '1.15rem', color: 'var(--color-accent)' },
  link: { color: 'var(--color-text-secondary)', fontWeight: 500, fontSize: '0.9rem' },
  name: { color: 'var(--color-text-secondary)', fontSize: '0.85rem', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  balance: { color: 'var(--color-text-hint)', fontSize: '0.8rem', fontFamily: 'monospace' },
  balanceLoading: { color: 'var(--color-text-muted)', fontSize: '0.8rem' },
  themeToggle: { background: 'transparent', border: 'none', fontSize: '1.2rem', cursor: 'pointer', padding: '0.4rem 0.6rem', borderRadius: '6px', transition: 'background 0.15s' },
  bellWrap: { position: 'relative' },
  bellBtn: {
    background: 'transparent',
    border: 'none',
    fontSize: '1.1rem',
    cursor: 'pointer',
    padding: '0.3rem 0.5rem',
    borderRadius: '6px',
    position: 'relative',
    lineHeight: 1,
  },
  badge: {
    position: 'absolute',
    top: '-2px',
    right: '-4px',
    background: 'var(--color-accent, #6366f1)',
    color: '#fff',
    fontSize: '0.65rem',
    fontWeight: 700,
    minWidth: '16px',
    height: '16px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 3px',
    lineHeight: 1,
  },
};
