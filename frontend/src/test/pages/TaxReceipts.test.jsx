import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../renderWithProviders';
import TaxReceipts from '../../pages/TaxReceipts';

vi.mock('../../services/api', () => ({
  api: {
    getTaxReceipts: vi.fn(),
    downloadTaxReceiptsPdf: vi.fn(),
    downloadTaxReceiptPdf: vi.fn(),
  },
}));

import { api } from '../../services/api';

const SAMPLE_RECEIPT = {
  id: 'contrib-101',
  campaign_id: 'camp-1',
  campaign_title: 'Solar Microgrid for Clinics',
  campaign_status: 'active',
  amount: '125.5',
  asset: 'USDC',
  tx_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
  memo: 'cp-camp1',
  ledger_sequence: 543210,
  stellar_network: 'testnet',
  sender_public_key: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
  destination_public_key: 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM',
  explorer_url:
    'https://stellar.expert/explorer/testnet/tx/a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
  horizon_tx_url:
    'https://horizon-testnet.stellar.org/transactions/a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
  created_at: '2026-10-20T14:30:00.000Z',
};

describe('TaxReceipts page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders contributor receipts with verifiable Stellar transaction references', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: [SAMPLE_RECEIPT] });

    renderWithProviders(<TaxReceipts />);

    expect(await screen.findByText('Solar Microgrid for Clinics')).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_RECEIPT.tx_hash)).toBeInTheDocument();
    expect(screen.getByText('cp-camp1')).toBeInTheDocument();
    expect(screen.getByText(/#543210/)).toBeInTheDocument();

    const explorerLink = screen.getByRole('link', { name: /View transaction/i });
    expect(explorerLink).toHaveAttribute('href', SAMPLE_RECEIPT.explorer_url);

    const horizonLink = screen.getByRole('link', { name: /Verify on Horizon API/i });
    expect(horizonLink).toHaveAttribute('href', SAMPLE_RECEIPT.horizon_tx_url);
  });

  it('shows empty state when no receipts exist and error alert on API failure', async () => {
    api.getTaxReceipts.mockResolvedValueOnce({ receipts: [] });
    const { unmount } = renderWithProviders(<TaxReceipts />);
    expect(await screen.findByText(/No contribution receipts are available yet/i)).toBeInTheDocument();
    unmount();

    api.getTaxReceipts.mockRejectedValueOnce(new Error('Failed to fetch receipts'));
    renderWithProviders(<TaxReceipts />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch receipts');
  });

  it('triggers single PDF download and surfaces download errors', async () => {
    api.getTaxReceipts.mockResolvedValue({ receipts: [SAMPLE_RECEIPT] });
    api.downloadTaxReceiptPdf.mockRejectedValueOnce(new Error('PDF service unavailable'));

    renderWithProviders(<TaxReceipts />);
    const btn = await screen.findByRole('button', { name: /Download PDF/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(api.downloadTaxReceiptPdf).toHaveBeenCalledWith('contrib-101');
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF service unavailable');
  });
});
