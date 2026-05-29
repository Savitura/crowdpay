import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CampaignCard from './CampaignCard';

const baseCampaign = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Solar Study Hub',
  description: 'Evening study lighting for a neighborhood learning hub in Yaba.',
  target_amount: 1000,
  raised_amount: 250,
  asset_type: 'USDC',
  status: 'active',
  contributor_count: 12,
};

function renderCard(campaign = baseCampaign) {
  return render(
    <MemoryRouter>
      <CampaignCard campaign={campaign} />
    </MemoryRouter>
  );
}

describe('CampaignCard', () => {
  it('renders campaign title and description excerpt', () => {
    renderCard();
    expect(screen.getByText('Solar Study Hub')).toBeInTheDocument();
    expect(screen.getByText(/Evening study lighting/)).toBeInTheDocument();
  });

  it('shows progress bar width from raised_amount / target_amount', () => {
    const { container } = renderCard();
    const fill = container.querySelector('[style*="width"]');
    const progress = Array.from(container.querySelectorAll('div')).find(
      (el) => el.getAttribute('style')?.includes('width: 25%')
    );
    expect(progress || fill).toBeTruthy();
    expect(screen.getByText(/25\.0%/)).toBeInTheDocument();
  });

  it('shows the asset type badge', () => {
    renderCard();
    expect(screen.getByText('USDC')).toBeInTheDocument();
  });

  it('shows goal reached badge when status is funded', () => {
    renderCard({ ...baseCampaign, status: 'funded' });
    expect(screen.getByText('Goal reached')).toBeInTheDocument();
  });

  it('shows campaign ended badge when status is failed', () => {
    renderCard({ ...baseCampaign, status: 'failed' });
    expect(screen.getByText('Campaign ended')).toBeInTheDocument();
  });
});
