import styles from './opsStyles';

export default function OpsOverviewPanel({ healthData, handleOpenHistory }) {
  const score = healthData?.system_health_score ?? 100;
  const scoreColor = score >= 85 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';

  return (
    <>
      {/* Main Health Score Gauge & Top Stats */}
      <div style={styles.overviewGrid}>
        <div style={styles.scoreCard}>
          <div style={styles.scoreGaugeContainer}>
            <div style={{ ...styles.scoreGauge, borderColor: scoreColor }}>
              <span style={{ ...styles.scoreValue, color: scoreColor }}>{score}</span>
              <span style={styles.scoreLabel}>/ 100</span>
            </div>
          </div>
          <div style={styles.scoreMeta}>
            <div
              style={{
                ...styles.statusPill,
                backgroundColor: `${scoreColor}22`,
                color: scoreColor,
              }}
            >
              {score >= 85
                ? 'SYSTEM OPERATIONAL'
                : score >= 60
                  ? 'DEGRADED PERFORMANCE'
                  : 'CRITICAL INCIDENTS'}
            </div>
            <div style={styles.lastCollected}>
              Last collection:{' '}
              {healthData?.collected_at
                ? new Date(healthData.collected_at).toLocaleTimeString()
                : 'Just now'}
            </div>
          </div>
        </div>

        {/* Subsystem Telemetry Cards */}
        <div
          style={styles.telemetryCard}
          onClick={() => handleOpenHistory('horizon_testnet_latency_ms')}
          title="Click to view latency history"
        >
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>Horizon Node Health</span>
            <span
              style={{
                ...styles.badge,
                backgroundColor: healthData?.horizon?.testnet?.ok ? '#10b98122' : '#ef444422',
                color: healthData?.horizon?.testnet?.ok ? '#10b981' : '#ef4444',
              }}
            >
              {healthData?.horizon?.testnet?.ok ? 'ONLINE' : 'DOWN'}
            </span>
          </div>
          <div style={styles.metricVal}>
            {healthData?.horizon?.testnet?.latency_ms ?? 0}{' '}
            <span style={styles.metricUnit}>ms</span>
          </div>
          <div style={styles.cardDetail}>
            Ledger staleness:{' '}
            <strong>{healthData?.horizon?.ledger?.staleness_seconds ?? 0}s</strong>
          </div>
          <div style={styles.sparkHint}>📈 Click to view 24h latency chart</div>
        </div>

        <div style={styles.telemetryCard}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>SSE Payment Streams</span>
            <span style={styles.badgeNeutral}>
              {healthData?.sse_streams?.active_connections ?? 0} ACTIVE
            </span>
          </div>
          <div style={styles.metricVal}>
            {healthData?.sse_streams?.dropped_count === 0
              ? '0'
              : healthData?.sse_streams?.dropped_count}
            <span style={styles.metricUnit}> dropped</span>
          </div>
          <div style={styles.cardDetail}>
            Monitored campaigns: <strong>{healthData?.sse_streams?.total_monitored ?? 0}</strong>
          </div>
        </div>

        <div style={styles.telemetryCard}>
          <div style={styles.cardHeader}>
            <span style={styles.cardTitle}>Platform Co-Signer</span>
            <span
              style={{
                ...styles.badge,
                backgroundColor:
                  (healthData?.platform_wallet?.balance_xlm ?? 0) >= 10 ? '#10b98122' : '#ef444422',
                color:
                  (healthData?.platform_wallet?.balance_xlm ?? 0) >= 10 ? '#10b981' : '#ef4444',
              }}
            >
              {(healthData?.platform_wallet?.balance_xlm ?? 0) >= 10 ? 'HEALTHY' : 'LOW BALANCE'}
            </span>
          </div>
          <div style={styles.metricVal}>
            {healthData?.platform_wallet?.balance_xlm?.toFixed(2) ?? '0.00'}{' '}
            <span style={styles.metricUnit}>XLM</span>
          </div>
          <div style={styles.cardDetail}>
            Pending txs:{' '}
            <strong>{healthData?.platform_wallet?.pending_transactions_count ?? 0}</strong> (Est.
            needed: {healthData?.platform_wallet?.estimated_xlm_needed ?? 0} XLM)
          </div>
        </div>
      </div>
    </>
  );
}
