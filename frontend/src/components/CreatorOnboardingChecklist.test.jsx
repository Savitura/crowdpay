import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CreatorOnboardingChecklist from './CreatorOnboardingChecklist';
import { saveDraft } from '../lib/campaignDraft';

const DISMISS_KEY = 'cp_creator_checklist_dismissed';

const creator = { id: 'u1', role: 'creator', name: '', wallet_public_key: null };

function renderChecklist(props = {}) {
  return render(
    <MemoryRouter>
      <CreatorOnboardingChecklist user={creator} campaigns={[]} {...props} />
    </MemoryRouter>
  );
}

describe('CreatorOnboardingChecklist', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  describe('visibility', () => {
    it('renders for a creator with no published campaigns', () => {
      renderChecklist();
      expect(screen.getByTestId('creator-onboarding-checklist')).toBeInTheDocument();
    });

    it('renders for an admin', () => {
      renderChecklist({ user: { ...creator, role: 'admin' } });
      expect(screen.getByTestId('creator-onboarding-checklist')).toBeInTheDocument();
    });

    it('is hidden for contributors and when there is no user', () => {
      const { unmount } = renderChecklist({ user: { ...creator, role: 'contributor' } });
      expect(screen.queryByTestId('creator-onboarding-checklist')).not.toBeInTheDocument();
      unmount();
      renderChecklist({ user: null });
      expect(screen.queryByTestId('creator-onboarding-checklist')).not.toBeInTheDocument();
    });

    it('is hidden once a campaign is published', () => {
      renderChecklist({ campaigns: [{ id: 'c1', status: 'active' }] });
      expect(screen.queryByTestId('creator-onboarding-checklist')).not.toBeInTheDocument();
    });

    it('is hidden when stats show active campaigns, even without a campaign list', () => {
      renderChecklist({ stats: { active_campaigns: 2 } });
      expect(screen.queryByTestId('creator-onboarding-checklist')).not.toBeInTheDocument();
    });

    it('stays visible when the only campaign is a draft', () => {
      renderChecklist({ campaigns: [{ id: 'c1', status: 'draft' }] });
      expect(screen.getByTestId('creator-onboarding-checklist')).toBeInTheDocument();
    });
  });

  describe('progress computation', () => {
    it('shows 0/7 · 0% for a brand-new creator', () => {
      renderChecklist();
      expect(screen.getByText('0/7 · 0%')).toBeInTheDocument();
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '0');
      expect(bar).toHaveAttribute('aria-valuemin', '0');
      expect(bar).toHaveAttribute('aria-valuemax', '100');
    });

    it('counts profile, wallet and KYC from the user record', () => {
      renderChecklist({
        user: {
          ...creator,
          name: 'Ada',
          wallet_public_key: 'GABC',
          kyc_status: 'verified',
        },
      });
      expect(screen.getByText('3/7 · 43%')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43');
    });

    it('accepts verification_status as an alternative KYC signal', () => {
      renderChecklist({ user: { ...creator, verification_status: 'verified' } });
      expect(screen.getByText('1/7 · 14%')).toBeInTheDocument();
    });

    it('counts campaign-derived steps (create, goal, media) from a draft campaign', () => {
      renderChecklist({
        campaigns: [
          {
            id: 'c1',
            status: 'draft',
            target_amount: '500',
            deadline: '2027-01-01',
            description: 'A story',
            cover_image_url: 'https://img/x.png',
          },
        ],
      });
      expect(screen.getByText('3/7 · 43%')).toBeInTheDocument();
    });

    it('does not count goal without a deadline', () => {
      renderChecklist({
        campaigns: [{ id: 'c1', status: 'draft', target_amount: '500' }],
      });
      // Only "create first campaign" is satisfied.
      expect(screen.getByText('1/7 · 14%')).toBeInTheDocument();
    });

    it('counts steps satisfied by the locally saved campaign draft', () => {
      saveDraft(
        {
          title: 'My draft',
          description: 'Story',
          cover_image_url: 'https://img/x.png',
          target_amount: '100',
          deadline: '2027-01-01',
        },
        1
      );
      renderChecklist();
      // create + goal + media
      expect(screen.getByText('3/7 · 43%')).toBeInTheDocument();
    });

    it('treats a corrupt draft as no draft', () => {
      window.localStorage.setItem('crowdpay:campaign_draft', '{not json');
      renderChecklist();
      expect(screen.getByText('0/7 · 0%')).toBeInTheDocument();
    });
  });

  describe('step navigation links', () => {
    it('links every incomplete step to its destination', () => {
      renderChecklist();
      expect(screen.getByRole('link', { name: 'Complete profile' })).toHaveAttribute(
        'href',
        '/profile'
      );
      expect(screen.getByRole('link', { name: 'Connect Stellar wallet' })).toHaveAttribute(
        'href',
        '/profile'
      );
      expect(screen.getByRole('link', { name: 'Complete KYC verification' })).toHaveAttribute(
        'href',
        '/profile'
      );
      expect(screen.getByRole('link', { name: 'Create first campaign' })).toHaveAttribute(
        'href',
        '/campaigns/new'
      );
      expect(screen.getByRole('link', { name: 'Set funding goal and deadline' })).toHaveAttribute(
        'href',
        '/campaigns/new'
      );
      expect(
        screen.getByRole('link', { name: 'Add campaign description and media' })
      ).toHaveAttribute('href', '/campaigns/new');
      expect(screen.getByRole('link', { name: 'Preview and launch' })).toHaveAttribute(
        'href',
        '/campaigns/new'
      );
    });

    it('renders completed steps as plain text without a link', () => {
      renderChecklist({ user: { ...creator, name: 'Ada' } });
      expect(screen.queryByRole('link', { name: 'Complete profile' })).not.toBeInTheDocument();
      const done = screen.getByText('Complete profile').closest('li');
      expect(done).toHaveClass('is-done');
      expect(within(done).queryByRole('link')).not.toBeInTheDocument();
    });

    it('links to account settings so the checklist can be reopened', () => {
      renderChecklist();
      expect(screen.getByRole('link', { name: 'account settings' })).toHaveAttribute(
        'href',
        '/profile'
      );
    });
  });

  describe('dismissal persistence', () => {
    it('hides the checklist and persists dismissal to localStorage', async () => {
      renderChecklist();
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByTestId('creator-onboarding-checklist')).not.toBeInTheDocument();
      expect(window.localStorage.getItem(DISMISS_KEY)).toBe('1');
    });

    it('stays hidden on a later mount once dismissed', async () => {
      const first = renderChecklist();
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      first.unmount();
      renderChecklist();
      expect(screen.queryByTestId('creator-onboarding-checklist')).not.toBeInTheDocument();
    });

    it('is shown again after the dismissal flag is cleared (restore from settings)', () => {
      window.localStorage.setItem(DISMISS_KEY, '1');
      const first = renderChecklist();
      expect(screen.queryByTestId('creator-onboarding-checklist')).not.toBeInTheDocument();
      first.unmount();
      window.localStorage.removeItem(DISMISS_KEY);
      renderChecklist();
      expect(screen.getByTestId('creator-onboarding-checklist')).toBeInTheDocument();
    });
  });
});
