import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CampaignDataRoom from './CampaignDataRoom';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getCampaignDataRoomFiles: vi.fn(),
    getCampaignDataRoomDownload: vi.fn(),
    uploadCampaignDataRoomFile: vi.fn(),
    updateCampaignDataRoomFile: vi.fn(),
    deleteCampaignDataRoomFile: vi.fn(),
    getCampaignDataRoomLogs: vi.fn(),
  },
}));

describe('CampaignDataRoom component', () => {
  const mockCampaignId = 'camp-123';
  const mockUser = { id: 'u-owner', name: 'Campaign Owner' };

  const mockFilesData = {
    files: [
      {
        id: 'f-1',
        name: 'Q3 Financial Statements',
        original_filename: 'q3_financials.pdf',
        category: 'financials',
        access_level: 'backer',
        file_size: 1048576, // 1 MB
        created_at: '2026-09-01T12:00:00Z',
        can_manage: true,
      },
      {
        id: 'f-2',
        name: 'Technical Architecture Whitepaper',
        original_filename: 'arch.pdf',
        category: 'technical',
        access_level: 'public',
        file_size: 2097152, // 2 MB
        created_at: '2026-08-15T12:00:00Z',
        can_manage: true,
      },
    ],
    total: 2,
    user_role: 'owner',
    can_upload: true,
    can_view_logs: true,
    categories_summary: {
      financials: 1,
      technical: 1,
      pitch_deck: 0,
      legal: 0,
      diligence: 0,
      governance: 0,
      other: 0,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCampaignDataRoomFiles.mockResolvedValue(mockFilesData);
    api.getCampaignDataRoomDownload.mockResolvedValue({
      download_url: 'https://cdn.example.com/download.pdf',
    });
  });

  it('renders data room header, role badge, and documents list', async () => {
    render(<CampaignDataRoom campaignId={mockCampaignId} user={mockUser} />);

    expect(await screen.findByText('Campaign Data Room')).toBeInTheDocument();
    expect(screen.getByText(/Role: owner/i)).toBeInTheDocument();
    expect(await screen.findByText('Q3 Financial Statements')).toBeInTheDocument();
    expect(screen.getByText('Technical Architecture Whitepaper')).toBeInTheDocument();
    expect(screen.getByText('1 MB')).toBeInTheDocument();
    expect(screen.getByText('2 MB')).toBeInTheDocument();
  });

  it('filters documents when a category pill is clicked', async () => {
    const user = userEvent.setup();
    render(<CampaignDataRoom campaignId={mockCampaignId} user={mockUser} />);

    expect(await screen.findByText('Q3 Financial Statements')).toBeInTheDocument();

    const financialsBtn = screen.getByRole('button', { name: /Financials \(1\)/i });
    await user.click(financialsBtn);

    expect(api.getCampaignDataRoomFiles).toHaveBeenCalledWith(
      mockCampaignId,
      expect.objectContaining({ category: 'financials' })
    );
  });

  it('triggers download when download button is clicked', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => {});

    render(<CampaignDataRoom campaignId={mockCampaignId} user={mockUser} />);

    const downloadButtons = await screen.findAllByRole('button', { name: /Download/i });
    expect(downloadButtons.length).toBeGreaterThan(0);

    await user.click(downloadButtons[0]);

    expect(api.getCampaignDataRoomDownload).toHaveBeenCalledWith(mockCampaignId, 'f-1');
    expect(openSpy).toHaveBeenCalledWith(
      'https://cdn.example.com/download.pdf',
      '_blank',
      'noopener,noreferrer'
    );
    openSpy.mockRestore();
  });

  it('opens and submits upload modal when authorized', async () => {
    const user = userEvent.setup();
    api.uploadCampaignDataRoomFile.mockResolvedValue({ id: 'f-3', name: 'New Doc' });

    render(<CampaignDataRoom campaignId={mockCampaignId} user={mockUser} />);

    const uploadBtn = await screen.findByRole('button', { name: /\+ Upload Document/i });
    await user.click(uploadBtn);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Upload Data Room Document')).toBeInTheDocument();

    // Switch to URL mode for simple synthetic test
    const urlRadio = screen.getByLabelText(/External Document Link/i);
    await user.click(urlRadio);

    const urlInput = screen.getByLabelText(/Document URL \*/i);
    await user.type(urlInput, 'https://cdn.example.com/spec.pdf');

    const nameInput = screen.getByLabelText(/Document Title \*/i);
    await user.type(nameInput, 'API Specification');

    const submitBtn = screen.getByRole('button', { name: /Confirm Upload/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(api.uploadCampaignDataRoomFile).toHaveBeenCalledWith(
        mockCampaignId,
        expect.objectContaining({
          name: 'API Specification',
          file_url: 'https://cdn.example.com/spec.pdf',
        })
      );
    });
  });

  it('switches to access logs tab and displays audit entries', async () => {
    const user = userEvent.setup();
    api.getCampaignDataRoomLogs.mockResolvedValue({
      logs: [
        {
          id: 'log-1',
          action: 'download',
          file_name: 'Q3 Financial Statements',
          user_name: 'Bob Backer',
          ip_address: '192.168.1.1',
          created_at: '2026-09-02T10:00:00Z',
        },
      ],
      total: 1,
    });

    render(<CampaignDataRoom campaignId={mockCampaignId} user={mockUser} />);

    const logsTab = await screen.findByRole('tab', { name: /Access Logs/i });
    await user.click(logsTab);

    expect(await screen.findByText('Data Room Audit Trail & Access Logs')).toBeInTheDocument();
    expect(await screen.findByText('Bob Backer')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
  });
});
