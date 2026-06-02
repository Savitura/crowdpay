import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import RelativeTime from './RelativeTime';

export default function NotificationDropdown({ notifications, onMarkRead, onMarkAllRead, onClose }) {
  const navigate = useNavigate();

  async function handleClick(notif) {
    onClose();
    if (!notif.read_at) {
      await api.markNotificationRead(notif.id).catch(() => {});
      onMarkRead(notif.id);
    }
    if (notif.link) navigate(notif.link);
  }

  return (
    <div style={styles.dropdown}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Notifications</span>
        <button style={styles.markAll} onClick={onMarkAllRead}>Mark all as read</button>
      </div>
      {notifications.length === 0 ? (
        <div style={styles.empty}>No notifications yet.</div>
      ) : (
        notifications.map((n) => (
          <button
            key={n.id}
            style={{ ...styles.item, background: n.read_at ? 'transparent' : 'var(--color-accent-muted, rgba(99,102,241,0.08))' }}
            onClick={() => handleClick(n)}
          >
            <div style={styles.itemTitle}>{n.title}</div>
            {n.body && <div style={styles.itemBody}>{n.body}</div>}
            <div style={styles.itemTime}><RelativeTime date={n.created_at} /></div>
          </button>
        ))
      )}
    </div>
  );
}

const styles = {
  dropdown: {
    position: 'absolute',
    top: '110%',
    right: 0,
    width: '320px',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    borderRadius: '10px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
    zIndex: 100,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.75rem 1rem',
    borderBottom: '1px solid var(--color-border)',
  },
  headerTitle: {
    fontWeight: 700,
    fontSize: '0.9rem',
    color: 'var(--color-text)',
  },
  markAll: {
    background: 'transparent',
    border: 'none',
    color: 'var(--color-accent)',
    fontSize: '0.78rem',
    cursor: 'pointer',
    padding: 0,
  },
  item: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '0.75rem 1rem',
    border: 'none',
    borderBottom: '1px solid var(--color-border)',
    cursor: 'pointer',
    transition: 'filter 0.1s',
  },
  itemTitle: {
    fontWeight: 600,
    fontSize: '0.85rem',
    color: 'var(--color-text)',
    marginBottom: '2px',
  },
  itemBody: {
    fontSize: '0.78rem',
    color: 'var(--color-text-secondary)',
    marginBottom: '4px',
  },
  itemTime: {
    fontSize: '0.72rem',
    color: 'var(--color-text-hint)',
  },
  empty: {
    padding: '1.5rem 1rem',
    textAlign: 'center',
    color: 'var(--color-text-secondary)',
    fontSize: '0.85rem',
  },
};
