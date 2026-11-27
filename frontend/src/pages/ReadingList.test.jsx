import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ReadingList from './ReadingList';

const mockToast = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Link: ({ children, to, ...props }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../services/api', () => ({
  api: {
    getFavorites: vi.fn(),
    removeFavorite: vi.fn(),
  },
}));

import { api } from '../services/api';

describe('ReadingList', () => {
  const mockCampaigns = [
    {
      id: '1',
      title: 'Solar Energy Project',
      category: 'renewable energy',
      status: 'active',
      raised_amount: 5000,
      target_amount: 10000,
    },
    {
      id: '2',
      title: 'Community Garden',
      category: 'community',
      status: 'funded',
      raised_amount: 15000,
      target_amount: 10000,
    },
    {
      id: '3',
      title: 'Education Program',
      category: 'education',
      status: 'completed',
      raised_amount: 20000,
      target_amount: 20000,
    },
  ];

  beforeEach(() => {
    mockToast.mockClear();
    api.getFavorites.mockReset();
    api.removeFavorite.mockReset();
  });

  it('renders loading state initially', () => {
    api.getFavorites.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('loads and displays saved campaigns', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    expect(screen.getByText('Community Garden')).toBeInTheDocument();
    expect(screen.getByText('Education Program')).toBeInTheDocument();
    expect(api.getFavorites).toHaveBeenCalledTimes(1);
  });

  it('displays empty state when no campaigns saved', async () => {
    api.getFavorites.mockResolvedValue({ data: [] });
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });
    
    // Should show empty state message, not tax receipts message
    expect(screen.getByText(/browse campaigns/i)).toBeInTheDocument();
  });

  it('shows error toast when loading fails', async () => {
    api.getFavorites.mockRejectedValue(new Error('Network error'));
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('Failed to load reading list', 'error');
    });
  });

  it('filters campaigns by search query', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    await user.type(searchInput, 'garden');

    expect(screen.queryByText('Solar Energy Project')).not.toBeInTheDocument();
    expect(screen.getByText('Community Garden')).toBeInTheDocument();
    expect(screen.queryByText('Education Program')).not.toBeInTheDocument();
  });

  it('filters campaigns by category search', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    await user.type(searchInput, 'education');

    expect(screen.getByText('Education Program')).toBeInTheDocument();
    expect(screen.queryByText('Solar Energy Project')).not.toBeInTheDocument();
  });

  it('filters campaigns by status', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const filterSelect = screen.getByRole('combobox');
    await user.selectOptions(filterSelect, 'active');

    expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    expect(screen.queryByText('Community Garden')).not.toBeInTheDocument();
    expect(screen.queryByText('Education Program')).not.toBeInTheDocument();
  });

  it('shows no matches message when search yields no results', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    await user.type(searchInput, 'nonexistent');

    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
  });

  it('removes campaign from list when remove button clicked', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    api.removeFavorite.mockResolvedValue({});
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const removeButtons = screen.getAllByRole('button', { name: /✕/ });
    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(api.removeFavorite).toHaveBeenCalledWith('1');
    });

    expect(screen.queryByText('Solar Energy Project')).not.toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('Removed from reading list', 'info');
  });

  it('shows error toast when remove fails', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    api.removeFavorite.mockRejectedValue(new Error('Failed'));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const removeButtons = screen.getAllByRole('button', { name: /✕/ });
    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('Failed to remove', 'error');
    });

    expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
  });

  it('displays campaign progress percentage correctly', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('50.0%')).toBeInTheDocument(); // Solar Energy: 5000/10000
    });

    expect(screen.getByText('100.0%')).toBeInTheDocument(); // Education: 20000/20000
  });

  it('displays campaign raised amounts', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/5,000/)).toBeInTheDocument();
    });

    expect(screen.getByText(/15,000/)).toBeInTheDocument();
    expect(screen.getByText(/20,000/)).toBeInTheDocument();
  });

  it('displays campaign count correctly', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('renders links to campaign detail pages', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const links = screen.getAllByRole('link', { name: /view/i });
    expect(links[0]).toHaveAttribute('href', '/campaigns/1');
    expect(links[1]).toHaveAttribute('href', '/campaigns/2');
  });

  it('displays campaign status badges with correct styling', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('active')).toBeInTheDocument();
    });

    const activeStatus = screen.getByText('active');
    expect(activeStatus).toHaveClass('bg-green-100', 'text-green-700');

    const fundedStatus = screen.getByText('funded');
    expect(fundedStatus).toHaveClass('bg-blue-100', 'text-blue-700');

    const completedStatus = screen.getByText('completed');
    expect(completedStatus).toHaveClass('bg-gray-100', 'text-gray-600');
  });

  it('renders discover campaigns link in header', async () => {
    api.getFavorites.mockResolvedValue({ data: [] });
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      const discoverLink = screen.getByRole('link', { name: /discover campaigns/i });
      expect(discoverLink).toHaveAttribute('href', '/discover');
    });
  });

  it('applies combined search and status filters correctly', async () => {
    api.getFavorites.mockResolvedValue({ data: mockCampaigns });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ReadingList />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    await user.type(searchInput, 'energy');

    const filterSelect = screen.getByRole('combobox');
    await user.selectOptions(filterSelect, 'active');

    expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    expect(screen.queryByText('Community Garden')).not.toBeInTheDocument();
    expect(screen.queryByText('Education Program')).not.toBeInTheDocument();
  });
});
