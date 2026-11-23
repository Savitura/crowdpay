import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MilestoneProgressChart from '../../components/MilestoneProgressChart';

describe('MilestoneProgressChart', () => {
  it('renders fallback when data is empty or missing', () => {
    const { rerender } = render(<MilestoneProgressChart data={[]} />);
    expect(screen.getByText(/No milestones defined/i)).toBeInTheDocument();

    rerender(<MilestoneProgressChart data={null} />);
    expect(screen.getByText(/No milestones defined/i)).toBeInTheDocument();
  });

  it('renders the chart container when data is provided', () => {
    const data = [
      { name: 'Phase 1', progress: 100 },
      { name: 'Phase 2', progress: 50 },
    ];
    const { container } = render(<MilestoneProgressChart data={data} />);
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });
});
