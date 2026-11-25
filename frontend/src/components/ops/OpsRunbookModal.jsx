import styles from './opsStyles';

export default function OpsRunbookModal({
  activeRunbookModal,
  selectedIncident,
  setActiveRunbookModal,
  executionResult,
  runbookExecuting,
  handleExecuteRunbook,
}) {
  return (
    <>
      {/* Runbook Modal */}
      {activeRunbookModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalHeader}>
              <div>
                <h3 style={styles.modalTitle}>Automated Runbook Remediation</h3>
                <p style={styles.modalSubtitle}>Incident: {selectedIncident?.incident_type}</p>
              </div>
              <button onClick={() => setActiveRunbookModal(false)} style={styles.closeBtn}>
                ✕
              </button>
            </div>

            <div style={styles.modalContent}>
              {!executionResult && !runbookExecuting && (
                <div>
                  <p style={{ color: '#cbd5e1', marginBottom: '16px' }}>
                    Triggering this runbook will execute automated diagnostics, safe operational
                    locks, and state recovery.
                  </p>
                  <button onClick={handleExecuteRunbook} style={styles.primaryBtn}>
                    Start Runbook Execution
                  </button>
                </div>
              )}

              {runbookExecuting && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ color: '#38bdf8', marginBottom: '10px' }}>
                    ⚡ Executing runbook steps in real-time...
                  </div>
                  <div style={styles.spinner} />
                </div>
              )}

              {executionResult && (
                <div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '12px',
                    }}
                  >
                    <span style={{ fontWeight: '600', color: '#f8fafc' }}>
                      Execution Status:{' '}
                      <span
                        style={{
                          color: executionResult.status === 'completed' ? '#10b981' : '#f59e0b',
                        }}
                      >
                        {executionResult.status.toUpperCase()}
                      </span>
                    </span>
                    <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                      Finished at {new Date(executionResult.completed_at).toLocaleTimeString()}
                    </span>
                  </div>

                  <div style={styles.stepTimeline}>
                    {executionResult.steps?.map((step, idx) => (
                      <div key={idx} style={styles.stepItem}>
                        <div style={styles.stepHeader}>
                          <span style={styles.stepName}>{step.name}</span>
                          <span
                            style={{
                              ...styles.stepStatusBadge,
                              backgroundColor:
                                step.status === 'completed' ? '#10b98122' : '#f59e0b22',
                              color: step.status === 'completed' ? '#10b981' : '#f59e0b',
                            }}
                          >
                            {step.status}
                          </span>
                        </div>
                        <div style={styles.stepLog}>{step.log}</div>
                      </div>
                    ))}
                  </div>

                  {executionResult.status === 'requires_manual_action' && (
                    <div style={styles.manualActionBox}>
                      <strong>Action Required:</strong>
                      <p style={{ margin: '6px 0 0 0' }}>
                        {executionResult.result?.action_required ||
                          'Manual operator confirmation required.'}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={styles.modalFooter}>
              <button onClick={() => setActiveRunbookModal(false)} style={styles.secondaryBtn}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
