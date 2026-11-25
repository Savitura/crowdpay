import styles from './opsStyles';

export default function OpsWalletAuditPanel({ walletAudit, handleApproveWalletFunding }) {
  return (
    <>
      {/* Campaign Wallet Reserve Audit Table */}
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Campaign Wallet Reserve Audit</h2>
          <p style={styles.sectionDesc}>
            Enforces Stellar base reserve formula:{' '}
            <code>2 * base_reserve + trustlines * 0.5 XLM</code>
          </p>
        </div>
      </div>

      <div style={styles.tableCard}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Campaign</th>
              <th style={styles.th}>Wallet Public Key</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Current Balance</th>
              <th style={styles.th}>Min. Required</th>
              <th style={styles.th}>Deficit</th>
              <th style={styles.th}>Health</th>
              <th style={styles.th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {walletAudit.length === 0 ? (
              <tr>
                <td colSpan="8" style={{ ...styles.td, textAlign: 'center', color: '#94a3b8' }}>
                  No active campaign wallets currently found.
                </td>
              </tr>
            ) : (
              walletAudit.map((w) => (
                <tr key={w.campaign_id} style={w.deficit_xlm > 0 ? styles.tableRowWarning : {}}>
                  <td style={styles.td}>
                    <strong>{w.campaign_title || 'Untitled Campaign'}</strong>
                  </td>
                  <td style={styles.td}>
                    <code style={styles.code}>{w.wallet_public_key?.slice(0, 10)}...</code>
                  </td>
                  <td style={styles.td}>{w.campaign_status}</td>
                  <td style={styles.td}>{w.balance_xlm.toFixed(4)} XLM</td>
                  <td style={styles.td}>{w.min_required_xlm.toFixed(4)} XLM</td>
                  <td
                    style={{
                      ...styles.td,
                      color: w.deficit_xlm > 0 ? '#ef4444' : '#10b981',
                      fontWeight: 'bold',
                    }}
                  >
                    {w.deficit_xlm > 0 ? `-${w.deficit_xlm.toFixed(7)} XLM` : '0.0000000'}
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.statusBadge,
                        backgroundColor: w.health === 'ok' ? '#10b98122' : '#ef444422',
                        color: w.health === 'ok' ? '#10b981' : '#ef4444',
                      }}
                    >
                      {w.health.toUpperCase()}
                    </span>
                  </td>
                  <td style={styles.td}>
                    {w.deficit_xlm > 0 ? (
                      <button
                        onClick={() => handleApproveWalletFunding(w.campaign_id)}
                        style={styles.fundingBtn}
                      >
                        Approve Funding
                      </button>
                    ) : (
                      <span style={{ color: '#64748b', fontSize: '0.85rem' }}>Compliant</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
