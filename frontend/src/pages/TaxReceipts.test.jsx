import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TaxReceipts from './TaxReceipts';

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

vi.mock('../config/stellar', () => ({
  stellarExpertTxUrl: (hash) => `https://stellar.expert/tx/${hash}`,
}));

vi.mock('../services/api', () => ({
  api: {
    getTaxReceipts: vi.fn(),
    downloadTaxReceiptsPdf: vi.fn(),
    downloadTaxReceiptPdf: vi.fn(),
  },
}));

import { api } from '../services/api';

describe('TaxReceipts', () => {
  const mockReceipts = [
    {
      id: 'receipt-1',
      campaign_id: 'campaign-1',
      campaign_title: 'Solar Energy Project',
      campaign_status: 'active',
      amount: 1000,
      asset: 'USDC',
      tx_hash: 'abc123',
      created_at: '2024-01-15T10:30:00Z',
    },
    {
      id: 'receipt-2',
      campaign_id: 'campaign-2',
      campaign_title: 'Community Garden',
      campaign_status: 'funded',
      amount: 500.5,
      asset: 'XLM',
      tx_hash: 'def456',
      created_at: '2024-02-20T14:45:00Z',
    },
    {
      id: 'receipt-3',
      campaign_id: 'campaign-3',
      campaign_title: 'Education Program',
      campaign_status: 'completed',
      amount: 2500,
      asset: 'USDC',
      tx_hash: null,
      created_at: '2024-03-10T09:15:00Z',
    },
  ];

  let clickSpy;
  let removeSpy;
  let revokeObjectURLSpy;
  let createObjectURLSpy;

  beforeEach(() => {
    api.getTaxReceipts.mockReset();
    api.downloadTaxReceiptsPdf.mockReset();
    api.downloadTaxReceiptPdf.mockReset();

    // Spy on the anchor download steps instead of replacing document.createElement,
    // which React needs to build the tree.
    clickSpy = vi.spyOn(window.HTMLElement.prototype, 'click').mockImplementation(() => {});
    removeSpy = vi.spyOn(window.Element.prototype, 'remove').mockImplementation(() => {});
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
  });

  afterEach(() => {
    clickSpy.mockRestore();
    removeSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    createObjectURLSpy.mockRestore();
  });

  it('renders loading state initially', () => {
    api.getTaxReceipts.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );
    expect(screen.getByText(/loading receipts/i)).toBeInTheDocument();
  });

  it('loads and displays tax receipts', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    expect(screen.getByText('Community Garden')).toBeInTheDocument();
    expect(screen.getByText('Education Program')).toBeInTheDocument();
    expect(api.getTaxReceipts).toHaveBeenCalledTimes(1);
  });

  it('displays empty state when no receipts available', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: [] });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/no contribution receipts are available yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/browse campaigns/i)).toBeInTheDocument();
  });

  it('shows error message when loading fails', async () => {
    api.getTaxReceipts.mockRejectedValue(new Error('Network error'));
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('displays custom error message from API', async () => {
    api.getTaxReceipts.mockRejectedValue({ message: 'Custom API error' });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Custom API error')).toBeInTheDocument();
    });
  });

  it('displays receipt amounts correctly', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/1,000.*USDC/)).toBeInTheDocument();
    });

    expect(screen.getByText(/500.5.*XLM/)).toBeInTheDocument();
    expect(screen.getByText(/2,500.*USDC/)).toBeInTheDocument();
  });

  it('displays formatted dates and campaign status', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/active/)).toBeInTheDocument();
    });

    expect(screen.getByText(/funded/)).toBeInTheDocument();
    expect(screen.getByText(/completed/)).toBeInTheDocument();
  });

  it('renders transaction links when tx_hash is present', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      const txLinks = screen.getAllByText(/view transaction/i);
      expect(txLinks).toHaveLength(2); // Only receipts with tx_hash
    });

    const txLinks = screen.getAllByText(/view transaction/i);
    expect(txLinks[0]).toHaveAttribute('href', 'https://stellar.expert/tx/abc123');
    expect(txLinks[1]).toHaveAttribute('href', 'https://stellar.expert/tx/def456');
  });

  it('does not render transaction link when tx_hash is null', async () => {
    api.getTaxReceipts.mockResolvedValue({
      receipts: [mockReceipts[2]], // Only the receipt with null tx_hash
    });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Education Program')).toBeInTheDocument();
    });

    expect(screen.queryByText(/view transaction/i)).not.toBeInTheDocument();
  });

  it('renders campaign links correctly', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const campaignLinks = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/campaigns/'));
    expect(campaignLinks).toHaveLength(3);
    expect(campaignLinks[0]).toHaveAttribute('href', '/campaigns/campaign-1');
    expect(campaignLinks[1]).toHaveAttribute('href', '/campaigns/campaign-2');
    expect(campaignLinks[2]).toHaveAttribute('href', '/campaigns/campaign-3');
  });

  it('shows "Download all PDFs" button when receipts exist', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /download all pdfs/i })).toBeInTheDocument();
    });
  });

  it('hides "Download all PDFs" button when no receipts', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: [] });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /download all pdfs/i })).not.toBeInTheDocument();
    });
  });

  it('downloads individual receipt when button clicked', async () => {
    const mockBlob = new Blob(['pdf content'], { type: 'application/pdf' });
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptPdf.mockResolvedValue({
      blob: mockBlob,
      filename: 'receipt-1.pdf',
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadButtons = screen.getAllByRole('button', { name: /download pdf/i });
    await user.click(downloadButtons[0]);

    await waitFor(() => {
      expect(api.downloadTaxReceiptPdf).toHaveBeenCalledWith('receipt-1');
    });

    expect(clickSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalled();
  });

  it('downloads all receipts when "Download all PDFs" clicked', async () => {
    const mockBlob = new Blob(['all receipts pdf'], { type: 'application/pdf' });
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptsPdf.mockResolvedValue({
      blob: mockBlob,
      filename: 'all-receipts.pdf',
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadAllButton = screen.getByRole('button', { name: /download all pdfs/i });
    await user.click(downloadAllButton);

    await waitFor(() => {
      expect(api.downloadTaxReceiptsPdf).toHaveBeenCalledTimes(1);
    });

    expect(clickSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalled();
  });

  it('shows "Preparing..." state while downloading individual receipt', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptPdf.mockReturnValue(new Promise(() => {})); // Never resolves
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadButtons = screen.getAllByRole('button', { name: /download pdf/i });
    await user.click(downloadButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('Preparing...')).toBeInTheDocument();
    });

    const preparingButton = screen.getByRole('button', { name: /preparing/i });
    expect(preparingButton).toBeDisabled();
  });

  it('shows "Preparing..." state while downloading all receipts', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptsPdf.mockReturnValue(new Promise(() => {})); // Never resolves
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadAllButton = screen.getByRole('button', { name: /download all pdfs/i });
    await user.click(downloadAllButton);

    await waitFor(() => {
      expect(screen.getByText('Preparing...')).toBeInTheDocument();
    });

    const preparingButton = screen.getByRole('button', { name: /preparing/i });
    expect(preparingButton).toBeDisabled();
  });

  it('shows error when individual download fails', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptPdf.mockRejectedValue(new Error('Download failed'));
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadButtons = screen.getAllByRole('button', { name: /download pdf/i });
    await user.click(downloadButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('Download failed')).toBeInTheDocument();
    });
  });

  it('shows custom error message when individual download fails', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptPdf.mockRejectedValue({ message: 'Custom download error' });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadButtons = screen.getAllByRole('button', { name: /download pdf/i });
    await user.click(downloadButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('Custom download error')).toBeInTheDocument();
    });
  });

  it('shows error when download all fails', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptsPdf.mockRejectedValue(new Error('Download all failed'));
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadAllButton = screen.getByRole('button', { name: /download all pdfs/i });
    await user.click(downloadAllButton);

    await waitFor(() => {
      expect(screen.getByText('Download all failed')).toBeInTheDocument();
    });
  });

  it('allows downloading multiple receipts sequentially', async () => {
    const mockBlob = new Blob(['pdf content'], { type: 'application/pdf' });
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptPdf.mockResolvedValue({
      blob: mockBlob,
      filename: 'receipt.pdf',
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadButtons = screen.getAllByRole('button', { name: /download pdf/i });

    await user.click(downloadButtons[0]);
    await waitFor(() => {
      expect(api.downloadTaxReceiptPdf).toHaveBeenCalledWith('receipt-1');
    });

    await user.click(downloadButtons[1]);
    await waitFor(() => {
      expect(api.downloadTaxReceiptPdf).toHaveBeenCalledWith('receipt-2');
    });

    expect(api.downloadTaxReceiptPdf).toHaveBeenCalledTimes(2);
  });

  it('disables only the clicked download button during download', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: mockReceipts });
    api.downloadTaxReceiptPdf.mockReturnValue(new Promise(() => {})); // Never resolves
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    const downloadButtons = screen.getAllByRole('button', { name: /download pdf/i });
    await user.click(downloadButtons[0]);

    await waitFor(() => {
      expect(downloadButtons[0]).toBeDisabled();
    });

    expect(downloadButtons[1]).not.toBeDisabled();
    expect(downloadButtons[2]).not.toBeDisabled();
  });

  it('cleans up on unmount during data fetch', async () => {
    api.getTaxReceipts.mockReturnValue(new Promise(() => {})); // Never resolves
    const { unmount } = render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    expect(screen.getByText(/loading receipts/i)).toBeInTheDocument();

    // Unmount should not cause errors or warnings
    unmount();
  });

  it('renders page title and description', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: [] });
    render(
      <MemoryRouter>
        <TaxReceipts />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Tax receipts')).toBeInTheDocument();
    });

    expect(
      screen.getByText(/download contribution receipts for your records/i)
    ).toBeInTheDocument();
  });
});
