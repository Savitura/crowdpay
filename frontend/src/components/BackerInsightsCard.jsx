import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

function shortenKey(key) {
  if (!key) return 'Unknown';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export default function BackerInsightsCard({ data, assetType = 'XLM' }) {
  if (!data) {
    return null;
  }

  const { total_backers = 0, repeat_rate = 0, new_backers_by_day = [], top_backers = [] } = data;

  return (
    <div className="campaign-card" style={{ minHeight: 'auto', marginTop: '0.75rem' }}>
      <strong style={{ display: 'block', marginBottom: '0.6rem' }}>Backer insights</strong>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.75rem',
          marginBottom: '0.75rem',
        }}
      >
        <div className="campaign-card" style={{ minHeight: 'auto', padding: '0.6rem 0.75rem' }}>
          <strong style={{ fontSize: '1rem' }}>{total_backers}</strong>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>Total backers</div>
        </div>
        <div className="campaign-card" style={{ minHeight: 'auto', padding: '0.6rem 0.75rem' }}>
          <strong style={{ fontSize: '1rem' }}>{repeat_rate.toFixed(0)}%</strong>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-hint)' }}>Repeat rate</div>
        </div>
      </div>

      <div style={{ marginBottom: '0.75rem' }}>
        <strong style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }}>
          Backer growth
        </strong>
        {new_backers_by_day.length > 0 ? (
          <ResponsiveContainer width="100%" height={180}>
            <LineChart
              data={new_backers_by_day.map((r) => ({
                ...r,
                new_backers: Number(r.new_backers) || 0,
              }))}
              margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(d) => d?.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} width={48} />
              <Tooltip formatter={(value) => [Number(value) || 0, 'New backers']} />
              <Line
                type="monotone"
                dataKey="new_backers"
                stroke="var(--color-accent)"
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>No backer growth data yet.</p>
        )}
      </div>

      <div>
        <strong style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }}>
          Top backers
        </strong>
        {top_backers.length > 0 ? (
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {top_backers.map((row) => (
              <div key={row.sender_public_key} className="campaign-card" style={{ minHeight: 'auto', padding: '0.6rem 0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>
                    {shortenKey(row.sender_public_key)}
                  </span>
                  <span style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem' }}>
                    {row.contribution_count} contributions · {Number(row.total_amount).toLocaleString()} {assetType}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>No backer activity yet.</p>
        )}
      </div>
    </div>
  );
}
