export default function ThankYouToast({ message, onDismiss }) {
  return (
    <>
      {message && (
        <div
          style={{
            position: 'fixed',
            bottom: '1.5rem',
            right: '1.5rem',
            background: '#22c55e',
            color: '#fff',
            padding: '0.75rem 1.25rem',
            borderRadius: '8px',
            fontSize: '0.9rem',
            fontWeight: 600,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 1001,
          }}
        >
          {message}
          <button
            onClick={onDismiss}
            style={{
              background: 'none',
              border: 'none',
              color: '#fff',
              marginLeft: '0.75rem',
              cursor: 'pointer',
              fontWeight: 700,
              fontSize: '1rem',
            }}
          >
            x
          </button>
        </div>
      )}
    </>
  );
}
