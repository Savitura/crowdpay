export default function Logo({ size = 28, showWordmark = true, color = 'var(--color-accent)' }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill={color} />
        <path
          d="M10 20.5C10 17.46 12.46 15 15.5 15H17"
          stroke="white"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M22 11.5C22 14.54 19.54 17 16.5 17H15"
          stroke="white"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path d="M15.5 15L13 12.5M15.5 15L13 17.5" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16.5 17L19 19.5M16.5 17L19 14.5" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {showWordmark && (
        <span style={{ fontWeight: 700, fontSize: `${size * 0.5}px`, color: 'var(--color-text-primary)' }}>
          CrowdPay
        </span>
      )}
    </span>
  );
}
