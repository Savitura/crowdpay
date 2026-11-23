import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AssetMixChart from '../../components/AssetMixChart';

describe('AssetMixChart', () => {
  it('renders fallback when data is empty or missing', () => {
    const { rerender } = render(<AssetMixChart data={[]} />);
    expect(screen.getByText(/No contribution data/i)).toBeInTheDocument();

    rerender(<AssetMixChart data={null} />);
    expect(screen.getByText(/No contribution data/i)).toBeInTheDocument();
  });

  it('renders the chart container when data is provided', () => {
    const data = [
      { name: 'XLM', value: 100 },
      { name: 'USDC', value: 200 },
    ];
    const { container } = render(<AssetMixChart data={data} />);
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });
});
