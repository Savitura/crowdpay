import styles from './opsStyles';

export default function OpsIncidentPanel({
  incidentTab,
  setIncidentTab,
  incidents,
  resolvedIncidents,
  handleAcknowledge,
  handleOpenRunbook,
}) {
  return (
    <>
      {/* Incidents & Remediation Section */}
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Incident Management & Runbooks</h2>
        <div style={styles.tabSwitch}>
          <button
            onClick={() => setIncidentTab('open')}
            style={incidentTab === 'open' ? styles.tabActive : styles.tabInactive}
          >
            Active Incidents ({incidents.length})
          </button>
          <button
            onClick={() => setIncidentTab('resolved')}
            style={incidentTab === 'resolved' ? styles.tabActive : styles.tabInactive}
          >
            Resolved (Last 24h: {resolvedIncidents.length})
          </button>
        </div>
      </div>

      {incidentTab === 'open' ? (
        incidents.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={{ fontSize: '2rem', marginBottom: '8px' }}>✨</div>
            <div style={{ fontWeight: '600', color: '#10b981' }}>All Systems Nominal</div>
            <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
              No open incidents or threshold violations detected.
            </p>
          </div>
        ) : (
          <div style={styles.incidentList}>
            {incidents.map((inc) => (
              <div key={inc.id} style={styles.incidentCard}>
                <div style={styles.incidentHeader}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        ...styles.severityTag,
                        backgroundColor: inc.severity === 'critical' ? '#ef4444' : '#f59e0b',
                      }}
                    >
                      {inc.severity.toUpperCase()}
                    </span>
                    <span style={styles.incidentType}>{inc.incident_type}</span>
                  </div>
                  <span style={styles.incidentTime}>
                    Detected: {new Date(inc.triggered_at).toLocaleTimeString()}
                  </span>
                </div>

                <div style={styles.incidentBody}>
                  <p style={styles.incidentMsg}>
                    {inc.details?.message || JSON.stringify(inc.triggering_metric_values)}
                  </p>
                </div>

                <div style={styles.incidentActions}>
                  {inc.status === 'open' && (
                    <button onClick={() => handleAcknowledge(inc.id)} style={styles.ackBtn}>
                      ✓ Acknowledge
                    </button>
                  )}
                  <button onClick={() => handleOpenRunbook(inc)} style={styles.runbookBtn}>
                    ⚡ Execute Runbook
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div style={styles.resolvedList}>
          {resolvedIncidents.length === 0 ? (
            <div style={styles.emptyState}>No resolved incidents in the past 24 hours.</div>
          ) : (
            resolvedIncidents.map((res) => (
              <div key={res.id} style={styles.resolvedRow}>
                <div>
                  <span style={{ fontWeight: '600', color: '#94a3b8' }}>{res.incident_type}</span>
                  <span style={{ marginLeft: '10px', fontSize: '0.8rem', color: '#64748b' }}>
                    Resolved at {new Date(res.resolved_at).toLocaleTimeString()}
                  </span>
                </div>
                <div style={{ fontSize: '0.85rem', color: '#10b981' }}>
                  Duration: {res.duration_seconds ? `${res.duration_seconds}s` : '< 1m'}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
