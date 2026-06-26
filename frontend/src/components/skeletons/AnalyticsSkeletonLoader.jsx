export default function AnalyticsSkeletonLoader() {
  return (
    <div style={{ marginBottom: '2rem' }} aria-hidden="true">
      <div className="skeleton" style={{ height: '20px', width: '120px', marginBottom: '0.75rem' }} />
      <div style={{ display: 'grid', gap: '1.5rem' }}>
        {/* Bar chart placeholder */}
        <div
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '10px',
            padding: '1.25rem',
            minHeight: '148px',
          }}
        >
          <div className="skeleton" style={{ height: '15px', width: '200px', marginBottom: '1rem' }} />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '90px' }}>
            {[60, 80, 45, 95, 70, 55, 85, 40, 75, 65].map((h, i) => (
              <div
                key={i}
                className="skeleton"
                style={{ flex: 1, height: `${h}%`, borderRadius: '2px' }}
              />
            ))}
          </div>
        </div>

        {/* Asset breakdown placeholder */}
        <div
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '10px',
            padding: '1.25rem',
            minHeight: '148px',
          }}
        >
          <div className="skeleton" style={{ height: '15px', width: '140px', marginBottom: '1rem' }} />
          {[100, 80].map((w, i) => (
            <div
              key={i}
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}
            >
              <div className="skeleton" style={{ height: '13px', width: `${w * 0.4}px` }} />
              <div className="skeleton" style={{ height: '13px', width: '60px' }} />
            </div>
          ))}
        </div>

        {/* Top contributors placeholder */}
        <div
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '10px',
            padding: '1.25rem',
            minHeight: '148px',
          }}
        >
          <div className="skeleton" style={{ height: '15px', width: '150px', marginBottom: '1rem' }} />
          {[90, 75, 85].map((w, i) => (
            <div
              key={i}
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}
            >
              <div className="skeleton" style={{ height: '13px', width: `${w}px` }} />
              <div className="skeleton" style={{ height: '13px', width: '80px' }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
