import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import OpsHistoryChart from '../../components/OpsHistoryChart';

describe('OpsHistoryChart', () => {
  it('renders the chart container when data is provided', () => {
    const data = [
      { time: '10:00', value: 25 },
      { time: '11:00', value: 40 },
    ];
    const { container } = render(<OpsHistoryChart data={data} />);
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });
});
