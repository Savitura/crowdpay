import React from 'react';
import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <main className="container page-narrow" style={{ paddingTop: '4rem', paddingBottom: '4rem', textAlign: 'center' }}>
      <div style={styles.code}>404</div>
      <h1 style={styles.heading}>Page not found</h1>
      <p style={styles.sub}>
        The page you're looking for doesn't exist or has been moved.
      </p>
      <div style={styles.actions}>
        <Link to="/">
          <button type="button" className="btn-primary">Back to home</button>
        </Link>
        <Link to="/">
          <button type="button" className="btn-secondary">Browse campaigns</button>
        </Link>
      </div>
    </main>
  );
}

const styles = {
  code: { fontSize: '5rem', fontWeight: 800, color: '#ede9fe', lineHeight: 1, marginBottom: '0.5rem' },
  heading: { fontSize: '1.5rem', fontWeight: 700, color: '#111', marginBottom: '0.75rem' },
  sub: { color: '#666', fontSize: '1rem', lineHeight: 1.55, marginBottom: '2rem' },
  actions: { display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' },
};
