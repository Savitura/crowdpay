export default function Logo({ size = 28, showWordmark = true, variant = 'default' }) {
  const wordmarkColor = variant === 'white' ? '#ffffff' : 'var(--color-text-primary)';
  const gradientId = `logo-gradient-${variant}`;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem' }}>
      <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#4f83f1" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
        </defs>
        <circle cx="20" cy="20" r="18" fill={`url(#${gradientId})`} />
        <path
          d="M27 14.5C25.2 11.9 22.2 10.2 18.8 10.2c-5.6 0-10.1 4.5-10.1 10s4.5 10 10.1 10c3.4 0 6.4-1.7 8.2-4.3"
          stroke="#ffffff"
          strokeWidth="3.4"
          strokeLinecap="round"
        />
      </svg>
      {showWordmark && (
        <span
          style={{
            fontWeight: 800,
            fontSize: `${size * 0.55}px`,
            color: wordmarkColor,
            letterSpacing: '-0.02em',
          }}
        >
          CrowdPay
        </span>
      )}
    </span>
  );
}
