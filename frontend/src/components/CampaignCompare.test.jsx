import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import CampaignCompare from './CampaignCompare';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getCampaigns: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

const mockCampaignsList = [
  { id: '1', title: 'Tech Innovation', category: 'technology', raised_amount: 5000, target_amount: 10000, asset_type: 'USDC' },
  { id: '2', title: 'Community Garden', category: 'community', raised_amount: 2000, target_amount: 4000, asset_type: 'USDC' },
  { id: '3', title: 'Arts Festival', category: 'arts', raised_amount: 1000, target_amount: 5000, asset_type: 'USDC' },
  { id: '4', title: 'Clean Energy', category: 'environment', raised_amount: 8000, target_amount: 8000, asset_type: 'USDC' },
  { id: '5', title: 'Medical Aid', category: 'health', raised_amount: 3000, target_amount: 6000, asset_type: 'USDC' },
];

describe('CampaignCompare component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches campaigns on mount and renders header', async () => {
    api.getCampaigns.mockResolvedValueOnce({ data: mockCampaignsList });

    render(
      <MemoryRouter>
        <CampaignCompare />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Compare Campaigns' })).toBeInTheDocument();
    expect(api.getCampaigns).toHaveBeenCalledWith({ limit: 50 });
  });

  it('opens campaign selector and adds multiple campaigns for comparison', async () => {
    api.getCampaigns.mockResolvedValueOnce({ data: mockCampaignsList });

    render(
      <MemoryRouter>
        <CampaignCompare />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(api.getCampaigns).toHaveBeenCalled();
    });

    // Click Add Campaign
    fireEvent.click(screen.getByRole('button', { name: 'Add Campaign' }));
    expect(screen.getByPlaceholderText('Search campaigns...')).toBeInTheDocument();

    // Select first campaign
    fireEvent.click(screen.getByText('Tech Innovation'));
    expect(screen.getAllByText('Tech Innovation').length).toBeGreaterThan(0);

    // Add second campaign
    fireEvent.click(screen.getByRole('button', { name: 'Add Campaign' }));
    fireEvent.click(screen.getByText('Community Garden'));
    expect(screen.getAllByText('Community Garden').length).toBeGreaterThan(0);
  });

  it('filters campaign choices by search input in selector dropdown', async () => {
    api.getCampaigns.mockResolvedValueOnce({ data: mockCampaignsList });

    render(
      <MemoryRouter>
        <CampaignCompare />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(api.getCampaigns).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Campaign' }));

    const searchInput = screen.getByPlaceholderText('Search campaigns...');
    fireEvent.change(searchInput, { target: { value: 'Arts' } });

    expect(screen.getByText('Arts Festival')).toBeInTheDocument();
    expect(screen.queryByText('Tech Innovation')).not.toBeInTheDocument();
  });

  it('shows no matching campaigns message when search query yields no results', async () => {
    api.getCampaigns.mockResolvedValueOnce({ data: mockCampaignsList });

    render(
      <MemoryRouter>
        <CampaignCompare />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(api.getCampaigns).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Campaign' }));
    fireEvent.change(screen.getByPlaceholderText('Search campaigns...'), { target: { value: 'Nonexistent' } });

    expect(screen.getByText('No matching campaigns')).toBeInTheDocument();
  });

  it('enforces maximum comparison limit of 4 campaigns', async () => {
    api.getCampaigns.mockResolvedValueOnce({ data: mockCampaignsList });

    render(
      <MemoryRouter>
        <CampaignCompare />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(api.getCampaigns).toHaveBeenCalled();
    });

    // Add 4 campaigns
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Add Campaign/ }));
      fireEvent.click(screen.getByText(mockCampaignsList[i].title));
    }

    const maxButton = screen.getByRole('button', { name: 'Max 4 campaigns' });
    expect(maxButton).toBeDisabled();
  });

  it('allows removing a campaign from comparison view', async () => {
    api.getCampaigns.mockResolvedValueOnce({ data: mockCampaignsList });

    render(
      <MemoryRouter>
        <CampaignCompare />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(api.getCampaigns).toHaveBeenCalled();
    });

    // Add campaign
    fireEvent.click(screen.getByRole('button', { name: 'Add Campaign' }));
    fireEvent.click(screen.getByText('Tech Innovation'));

    expect(screen.getAllByText('Tech Innovation').length).toBeGreaterThan(0);

    // Click remove button for Tech Innovation
    const removeButton = screen.getAllByRole('button').find(b => b.textContent !== 'Add Campaign' && b.getAttribute('type') === 'button');
    expect(removeButton).toBeDefined();
    fireEvent.click(removeButton);

    expect(screen.queryByText('Tech Innovation')).not.toBeInTheDocument();
  });
});
