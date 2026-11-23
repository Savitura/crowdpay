import PropTypes from 'prop-types';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

export default function MilestoneProgressChart({ data }) {
  if (!data || data.length === 0) {
    return <p style={{ color: 'var(--color-text-hint)' }}>No milestones defined</p>;
  }

  return (
    <div style={{ width: '100%', height: '220px' }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis type="number" domain={[0, 100]} />
          <YAxis dataKey="name" type="category" width={80} />
          <Tooltip />
          <Bar dataKey="progress" fill="#22c55e" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

MilestoneProgressChart.propTypes = {
  data: PropTypes.arrayOf(
    PropTypes.shape({
      name: PropTypes.string,
      progress: PropTypes.number,
    })
  ),
};
