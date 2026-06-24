import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ContributorDashboard from '../components/ContributorDashboard';

export default function MyContributions() {
  const { ready, user } = useAuth();

  if (!ready) {
    return (
      <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
        <p style={{ color: 'var(--color-text-hint)' }}>Restoring your session...</p>
      </main>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1rem' }}>My Contributions</h1>
      <ContributorDashboard />
    </main>
  );
}
