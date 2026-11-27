import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import ContributorIdentityPage from '../../pages/ContributorIdentityPage';
import { renderWithProviders } from '../renderWithProviders';

const { PUBLIC_KEY, DID, auth } = vi.hoisted(() => {
  const publicKey = 'GCONTRIBUTORPUBLICKEY';
  return {
    PUBLIC_KEY: publicKey,
    DID: `did:stellar:${publicKey}`,
    auth: { user: { id: 'user-1', wallet_public_key: publicKey } },
  };
});

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getContributorIdentityProfile: vi.fn(),
  registerContributorIdentity: vi.fn(),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, ready: true }),
}));

vi.mock('../../context/ToastContext', async () => {
  const actual = await vi.importActual('../../context/ToastContext');
  return { ...actual, useToast: () => toast };
});

vi.mock('../../services/api', () => ({ api: apiMocks }));

const PROFILE = {
  registered: true,
  did: DID,
  reputationScore: 620,
  attestations: [
    {
      type: 'kyc_basic',
      issuedAt: '2025-01-15T00:00:00.000Z',
      issuer: 'CrowdPay KYC',
      revoked: false,
    },
    {
      type: 'kyc_standard',
      issuedAt: '2025-02-01T00:00:00.000Z',
      revoked: true,
    },
  ],
  contributionStats: {
    totalCampaigns: 7,
    totalAmountUsd: 1234.56,
    successRate: 86,
  },
};

function renderIdentityPage() {
  return renderWithProviders(<ContributorIdentityPage />);
}

describe('ContributorIdentityPage page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = { id: 'user-1', wallet_public_key: PUBLIC_KEY };
  });

  it('loads the identity profile for the authenticated wallet and renders the loading state first', async () => {
    let resolveProfile;
    apiMocks.getContributorIdentityProfile.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      })
    );

    renderIdentityPage();

    expect(screen.getByRole('heading', { name: 'Contributor Identity' })).toBeInTheDocument();
    expect(screen.getByText('Loading identity…')).toBeInTheDocument();
    expect(apiMocks.getContributorIdentityProfile).toHaveBeenCalledWith(PUBLIC_KEY);

    await act(async () => {
      resolveProfile(PROFILE);
    });

    expect(await screen.findByText(DID)).toBeInTheDocument();
    expect(screen.queryByText('Loading identity…')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Reputation score: 620/ })).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('$1,234.56')).toBeInTheDocument();
    expect(screen.getByText('86%')).toBeInTheDocument();

    const explorerLink = screen.getByRole('link', { name: /View on Stellar Expert/i });
    expect(explorerLink.getAttribute('href')).toContain(`/account/${PUBLIC_KEY}`);
  });

  it('displays attestation status badges for verified, revoked and missing KYC levels', async () => {
    apiMocks.getContributorIdentityProfile.mockResolvedValue(PROFILE);

    renderIdentityPage();

    expect(await screen.findByText('Identity Attestations')).toBeInTheDocument();
    expect(screen.getByText('KYC Basic')).toBeInTheDocument();
    expect(screen.getByText('KYC Standard')).toBeInTheDocument();
    expect(screen.getByText('KYC Enhanced')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText('Not verified')).toBeInTheDocument();
    expect(screen.getByText(/Issuer: CrowdPay KYC/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Get Verified' })).toHaveLength(2);
  });

  it('registers an unregistered identity and reloads the profile', async () => {
    apiMocks.getContributorIdentityProfile
      .mockResolvedValueOnce({ ...PROFILE, registered: false, did: '' })
      .mockResolvedValueOnce(PROFILE);
    apiMocks.registerContributorIdentity.mockResolvedValue({});

    renderIdentityPage();

    expect(
      await screen.findByText('Your identity is not yet registered on-chain.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Register Identity' }));

    expect(await screen.findByText(DID)).toBeInTheDocument();
    expect(apiMocks.registerContributorIdentity).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith('Identity registered on-chain.', 'success');
    expect(apiMocks.getContributorIdentityProfile).toHaveBeenCalledTimes(2);
  });

  it('shows an error when the identity profile cannot be loaded', async () => {
    apiMocks.getContributorIdentityProfile.mockRejectedValue(
      new Error('Identity service unavailable')
    );

    renderIdentityPage();

    expect(await screen.findByText('Identity service unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Identity Attestations')).not.toBeInTheDocument();
  });

  it('does not request a profile when there is no authenticated user', () => {
    auth.user = null;

    renderIdentityPage();

    expect(apiMocks.getContributorIdentityProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Contributor Identity' })).not.toBeInTheDocument();
  });
});
