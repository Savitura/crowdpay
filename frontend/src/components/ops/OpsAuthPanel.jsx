import styles from './opsStyles';

export default function OpsAuthPanel({
  t,
  authError,
  tempKey,
  setTempKey,
  rememberKey,
  setRememberKey,
  handleKeySubmit,
}) {
  return (
    <div style={styles.authContainer}>
      <div style={styles.authCard}>
        <div style={styles.authHeader}>
          <div style={styles.authBadge}>SECURITY GATED</div>
          <h2 style={styles.authTitle}>Operations Centre</h2>
          <p style={styles.authSubtitle}>
            Please enter your <code>OPS_API_KEY</code> to access real-time system health, incident
            response, and automated runbooks.
          </p>
        </div>

        {authError && <div style={styles.errorAlert}>{authError}</div>}

        <form onSubmit={handleKeySubmit} style={styles.authForm}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Operations API Key</label>
            <input
              type="password"
              value={tempKey}
              onChange={(e) => setTempKey(e.target.value)}
              placeholder={t('opsCenter.apiKeyPlaceholder')}
              required
              style={styles.input}
            />
          </div>

          <div style={styles.checkboxRow}>
            <input
              type="checkbox"
              id="rememberKey"
              checked={rememberKey}
              onChange={(e) => setRememberKey(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            <label
              htmlFor="rememberKey"
              style={{ fontSize: '0.85rem', color: '#94a3b8', cursor: 'pointer' }}
            >
              Remember key in localStorage (not recommended on shared devices)
            </label>
          </div>

          {rememberKey && (
            <div style={styles.warningAlert} role="alert">
              ⚠️ Warning: Storing privileged keys in localStorage persists across browser sessions
              and increases exposure to XSS attacks. By default, keys are kept only in the current
              session.
            </div>
          )}

          <button type="submit" style={styles.primaryBtn}>
            Unlock Operations Centre
          </button>
        </form>
      </div>
    </div>
  );
}
