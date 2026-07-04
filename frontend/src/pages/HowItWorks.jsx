import { Link } from 'react-router-dom';

const STEPS = [
  {
    title: 'Discover a cause',
    body: 'Browse verified campaigns and see exactly what your contribution supports, including the creator’s verification status and funding progress.',
  },
  {
    title: 'Contribute in a few taps',
    body: 'Choose an amount and a payment method — your bank, your card, or a wallet you already have. No crypto knowledge required.',
  },
  {
    title: 'Track the impact',
    body: 'Follow milestones and updates from the creator as the campaign progresses, right up until the goal is reached.',
  },
  {
    title: 'Creators withdraw as milestones are approved',
    body: 'Funds release against agreed milestones rather than all at once, so backers can see progress before money moves.',
  },
];

export default function HowItWorks() {
  return (
    <main className="container" style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}>
      <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '0.75rem' }}>How CrowdPay works</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: '2rem', lineHeight: 1.6 }}>
        A short walkthrough of what happens between deciding to back a cause and seeing it funded.
      </p>
      <div style={{ display: 'grid', gap: '1.5rem' }}>
        {STEPS.map((step, i) => (
          <div key={step.title} style={{ display: 'flex', gap: '1rem' }}>
            <div
              style={{
                flexShrink: 0,
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                background: 'var(--color-accent-lightest)',
                color: 'var(--color-accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
              }}
            >
              {i + 1}
            </div>
            <div>
              <strong style={{ fontSize: '1rem', display: 'block', marginBottom: '0.25rem' }}>
                {step.title}
              </strong>
              <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.92rem', lineHeight: 1.6, margin: 0 }}>
                {step.body}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: '2.5rem' }}>
        <Link to="/discover" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          Explore campaigns →
        </Link>
      </div>
    </main>
  );
}
