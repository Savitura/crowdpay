export default function MilestonesSkeletonLoader({ rows = 3 }) {
  return (
    <section style={{ marginTop: '1.5rem' }} aria-hidden="true">
      <div className="skeleton" style={{ height: '20px', width: '180px', marginBottom: '0.75rem' }} />
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            style={{
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border-light)',
              borderRadius: '10px',
              padding: '1.25rem',
              minHeight: '148px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.65rem' }}>
              <div>
                <div className="skeleton" style={{ height: '11px', width: '70px', marginBottom: '0.3rem' }} />
                <div className="skeleton" style={{ height: '15px', width: `${120 + i * 20}px` }} />
              </div>
              <div className="skeleton" style={{ height: '22px', width: '68px', borderRadius: '999px' }} />
            </div>
            <div className="skeleton" style={{ height: '13px', width: '100%', marginBottom: '0.35rem' }} />
            <div className="skeleton" style={{ height: '13px', width: '75%', marginBottom: '0.55rem' }} />
            <div className="skeleton" style={{ height: '12px', width: '55%' }} />
          </div>
        ))}
      </div>
    </section>
  );
}
