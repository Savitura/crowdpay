import { Link } from 'react-router-dom';

const LINKS = [
  { to: '/how-it-works', title: 'How CrowdPay works', body: 'A short walkthrough of the discover-to-withdrawal flow.' },
  { to: '/pricing', title: 'Pricing', body: 'What CrowdPay charges, and what it never charges for.' },
  { to: '/developer', title: 'Developer API', body: 'Embed campaigns and read campaign data from your own site.' },
];

export default function Resources() {
  return (
    <main className="container" style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}>
      <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '0.75rem' }}>Resources</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: '2rem', lineHeight: 1.6 }}>
        Guides and tools for creators and backers.
      </p>
      <div style={{ display: 'grid', gap: '1rem' }}>
        {LINKS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="campaign-card"
            style={{ minHeight: 'auto', textDecoration: 'none', color: 'inherit', display: 'block' }}
          >
            <strong style={{ fontSize: '1rem' }}>{item.title}</strong>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.88rem', marginTop: '0.35rem' }}>
              {item.body}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
