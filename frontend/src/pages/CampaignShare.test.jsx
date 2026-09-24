import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import CampaignShare from './CampaignShare';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: '123' }),
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    ready: true,
  }),
}));

vi.mock('../components/CampaignQRCode', () => ({
  default: () => <div data-testid="campaign-qr-code" />,
}));

const mockGetCampaign = vi.fn();
const mockGetReferralProgram = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    getCampaign: (...args) => mockGetCampaign(...args),
    getReferralProgram: (...args) => mockGetReferralProgram(...args),
    createReferralLink: vi.fn(),
  },
}));

describe('CampaignShare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCampaign.mockResolvedValue({
      id: '123',
      title: 'Solar Energy Project',
      asset_type: 'USDC',
      target_amount: '10000',
      raised_amount: '5000',
    });
    mockGetReferralProgram.mockResolvedValue(null);
  });

  it('renders campaign share page with QR code and social sharing links', async () => {
    render(<CampaignShare />);

    await waitFor(() => {
      expect(screen.getByText('Solar Energy Project')).toBeInTheDocument();
    });

    expect(screen.getByTestId('campaign-qr-code')).toBeInTheDocument();

    const twitterBtn = screen.getByRole('link', { name: /twitter \/ x/i });
    expect(twitterBtn).toBeInTheDocument();
    expect(twitterBtn.getAttribute('href')).toContain('twitter.com/intent/tweet');

    const whatsappBtn = screen.getByRole('link', { name: /whatsapp/i });
    expect(whatsappBtn).toBeInTheDocument();
    expect(whatsappBtn.getAttribute('href')).toContain('whatsapp.com/send');

    const telegramBtn = screen.getByRole('link', { name: /telegram/i });
    expect(telegramBtn).toBeInTheDocument();
    expect(telegramBtn.getAttribute('href')).toContain('t.me/share/url');

    const linkedinBtn = screen.getByRole('link', { name: /linkedin/i });
    expect(linkedinBtn).toBeInTheDocument();
    expect(linkedinBtn.getAttribute('href')).toContain('linkedin.com/sharing/share-offsite');
  });
});
