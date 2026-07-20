import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import BackerInsightsCard from '../components/BackerInsightsCard';describe('BackerInsightsCard', () => {
  it('renders backer growth, repeat rate, and top backers', () => {
    render(
      <BackerInsightsCard
        data={{
          total_backers: 4,
          repeat_rate: 50,
          new_backers_by_day: [
            { day: '2024-01-01', new_backers: 1 },
            { day: '2024-01-02', new_backers: 2 },
          ],
          top_backers: [
            {
              sender_public_key: 'GB7L3V4Q5R6S7T8U9V0W1X2Y3Z4A5B6C7D8E9F0G1H2I3J4K5L6M7N8O9P0',
              contribution_count: 2,
              total_amount: '120',
            },
          ],
        }}
        assetType="XLM"
      />
    );

    expect(screen.getByText(/Backer insights/i)).toBeInTheDocument();
    expect(screen.getByText(/Backer growth/i)).toBeInTheDocument();
    expect(screen.getByText(/Repeat rate/i)).toBeInTheDocument();
    expect(screen.getByText(/Top backers/i)).toBeInTheDocument();
    expect(screen.getByText(/GB7L3V4Q/i)).toBeInTheDocument();
  });
});
