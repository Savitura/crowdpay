import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CampaignStatusBadge from './CampaignStatusBadge';

describe('CampaignStatusBadge', () => {
  it.each([
    ['funded', 'Goal reached', 'var(--color-success-bg)', 'var(--color-success-text)'],
    ['failed', 'Campaign ended', 'var(--color-error-bg)', 'var(--color-error-text)'],
    ['closed', 'Campaign closed', 'var(--color-surface)', 'var(--color-text-secondary)'],
    ['refunded', 'campaignStatus.refunded', 'var(--color-surface)', 'var(--color-text-secondary)'],
    ['draft', 'Draft', 'var(--color-warning-bg, #fffbeb)', 'var(--color-warning-text, #92400e)'],
    ['disputed', 'Dispute in progress', 'var(--color-error-bg)', 'var(--color-error-text)'],
  ])('renders the expected label and styles for "%s" status', (status, expectedText, bg, color) => {
    render(<CampaignStatusBadge status={status} />);

    const badge = screen.getByText(expectedText);
    expect(badge).toBeInTheDocument();
    expect(badge.tagName).toBe('SPAN');
    expect(badge.style.background).toBe(bg);
    expect(badge.style.color).toBe(color);
  });

  it.each(['active', 'refunding', 'paused', '', null, undefined, 'unknown'])(
    'renders nothing for "%s" status',
    (status) => {
      const { container } = render(<CampaignStatusBadge status={status} />);
      expect(container.firstChild).toBeNull();
    }
  );
});
