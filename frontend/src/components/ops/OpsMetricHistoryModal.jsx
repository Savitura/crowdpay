import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import styles from './opsStyles';

export default function OpsMetricHistoryModal({
  historyModalOpen,
  setHistoryModalOpen,
  historyMetric,
  historyLoading,
  historyData,
}) {
  return (
    <>
      {/* History Modal */}
      {historyModalOpen && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div style={styles.modalHeader}>
              <div>
                <h3 style={styles.modalTitle}>Metric Telemetry History</h3>
                <p style={styles.modalSubtitle}>{historyMetric}</p>
              </div>
              <button onClick={() => setHistoryModalOpen(false)} style={styles.closeBtn}>
                ✕
              </button>
            </div>

            <div style={{ padding: '16px', height: '300px' }}>
              {historyLoading ? (
                <div style={{ textAlign: 'center', paddingTop: '100px', color: '#94a3b8' }}>
                  Loading time-series...
                </div>
              ) : historyData.length === 0 ? (
                <div style={{ textAlign: 'center', paddingTop: '100px', color: '#94a3b8' }}>
                  No historical data recorded yet for this metric.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={historyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" stroke="#94a3b8" />
                    <YAxis stroke="#94a3b8" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1e293b',
                        borderColor: '#475569',
                        color: '#f8fafc',
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#38bdf8"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={styles.modalFooter}>
              <button onClick={() => setHistoryModalOpen(false)} style={styles.secondaryBtn}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
