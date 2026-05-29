import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export default function Navbar() {
  const { user, logout } = useAuth();
  const { dark, toggleTheme } = useTheme();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <nav style={styles.nav}>
      <div className="container nav-inner-wrap">
        <Link to="/" style={styles.logo}>CrowdPay</Link>
        <div className="nav-links">
          {user ? (
            <>
              {(user.role === 'creator' || user.role === 'admin') && (
                <Link to="/campaigns/new" style={styles.link}>Start Campaign</Link>
              )}
              <Link to="/dashboard" style={styles.link}>Dashboard</Link>
              <Link to="/my-contributions" style={styles.link}>My Contributions</Link>
              {user.role === 'admin' && <Link to="/admin" style={styles.link}>Admin</Link>}
              <Link to="/developer" style={styles.link}>Developer</Link>
              <span style={styles.name}>{user.name}</span>
              <button 
                onClick={toggleTheme} 
                style={styles.themeToggle}
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                title={dark ? 'Light mode' : 'Dark mode'}
              >
                {dark ? '☀️' : '🌙'}
              </button>
              <button onClick={handleLogout} className="btn-secondary" style={{ padding: '0.4rem 0.9rem' }}>
                Logout
              </button>
            </>
          ) : (
            <>
              <Link to="/login" style={styles.link}>Log in</Link>
              <button 
                onClick={toggleTheme} 
                style={styles.themeToggle}
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                title={dark ? 'Light mode' : 'Dark mode'}
              >
                {dark ? '☀️' : '🌙'}
              </button>
              <Link to="/register">
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
  themeToggle: { background: 'transparent', border: 'none', fontSize: '1.2rem', cursor: 'pointer', padding: '0.4rem 0.6rem', borderRadius: '6px', transition: 'background 0.15s' },
};
