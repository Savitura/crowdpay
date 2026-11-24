import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import AttestationsPanel from './AttestationsPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,
  }),
}));

describe('AttestationsPanel', () => {
  it('renders section title and all default attestation tiers', () => {
    render(<AttestationsPanel attestations={[]} />);

    expect(screen.getByText('Identity Attestations')).toBeInTheDocument();
    expect(screen.getByText('KYC Basic')).toBeInTheDocument();
    expect(screen.getByText('KYC Standard')).toBeInTheDocument();
    expect(screen.getByText('KYC Enhanced')).toBeInTheDocument();
    expect(screen.getByText('Government ID check')).toBeInTheDocument();
    expect(screen.getByText('Government ID + address verification')).toBeInTheDocument();
    expect(screen.getByText('Government ID + address + liveness check')).toBeInTheDocument();
  });

  it('renders "Not verified" badge state and triggers onStartKyc for unverified tiers', () => {
    const handleStartKyc = vi.fn();
    render(<AttestationsPanel attestations={[]} onStartKyc={handleStartKyc} />);

    const notVerifiedBadges = screen.getAllByText('Not verified');
    expect(notVerifiedBadges).toHaveLength(3);

    const ctaButtons = screen.getAllByRole('button', { name: /get verified/i });
    expect(ctaButtons).toHaveLength(3);

    fireEvent.click(ctaButtons[0]);
    expect(handleStartKyc).toHaveBeenCalledWith('kyc_basic');
  });

  it('renders "Verified" badge for active attestations and hides CTA button for verified tiers', () => {
    const attestations = [
      {
        type: 'kyc_basic',
        revoked: false,
        issuedAt: '2025-01-01T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        issuer: 'Authority Issuer',
      },
    ];
    const handleStartKyc = vi.fn();

    render(<AttestationsPanel attestations={attestations} onStartKyc={handleStartKyc} />);

    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText(/Issuer: Authority Issuer/)).toBeInTheDocument();

    // Only 2 CTAs remaining for standard & enhanced
    const ctaButtons = screen.getAllByRole('button', { name: /get verified/i });
    expect(ctaButtons).toHaveLength(2);
  });

  it('renders "Revoked" badge state for revoked attestations', () => {
    const attestations = [
      {
        type: 'kyc_standard',
        revoked: true,
        issuedAt: '2024-01-01T00:00:00Z',
      },
    ];
    const handleStartKyc = vi.fn();

    render(<AttestationsPanel attestations={attestations} onStartKyc={handleStartKyc} />);

    expect(screen.getByText('Revoked')).toBeInTheDocument();

    const ctaButtons = screen.getAllByRole('button', { name: /get verified/i });
    expect(ctaButtons).toHaveLength(3);

    fireEvent.click(ctaButtons[1]);
    expect(handleStartKyc).toHaveBeenCalledWith('kyc_standard');
  });

  it('renders "Expired" badge state for expired attestations', () => {
    const attestations = [
      {
        type: 'kyc_enhanced',
        revoked: false,
        issuedAt: '2020-01-01T00:00:00Z',
        expiresAt: '2021-01-01T00:00:00Z',
      },
    ];

    render(<AttestationsPanel attestations={attestations} />);

    expect(screen.getByText('Expired')).toBeInTheDocument();
  });
});
