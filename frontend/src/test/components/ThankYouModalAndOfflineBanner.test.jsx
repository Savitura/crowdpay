import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import ThankYouModal from '../../components/ThankYouModal';
import { OfflineBanner } from '../../components/OfflineBanner';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('../../context/NetworkStatusContext', () => ({
  useNetworkStatus: () => ({ isOnline: false }),
}));

vi.mock('../../services/api', () => ({
  api: {
    sendBulkThankYou: vi.fn(),
    sendContributionThankYou: vi.fn(),
  },
}));

describe('ThankYouModal and OfflineBanner in French locale', () => {
  it('renders OfflineBanner in French without raw keys', async () => {
    const { i18n } = useTranslation();
    await i18n.changeLanguage('fr');

    render(<OfflineBanner />);
    const banner = screen.getByRole('alert');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).not.toContain('offline.banner');
    expect(banner.textContent.length).toBeGreaterThan(0);
  });

  it('renders ThankYouModal in French without raw keys', async () => {
    const { i18n } = useTranslation();
    await i18n.changeLanguage('fr');

    render(
      <ThankYouModal campaignId="camp-1" contribution={null} onClose={() => {}} onSent={() => {}} />
    );

    expect(screen.getByText('Envoyer un message groupé de remerciement')).toBeInTheDocument();
    expect(screen.queryByText(/thankYou\./)).not.toBeInTheDocument();
  });
});
