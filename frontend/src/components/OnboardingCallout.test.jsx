import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OnboardingCallout from './OnboardingCallout';

describe('OnboardingCallout', () => {
  it('renders as a note landmark with its body content', () => {
    render(
      <OnboardingCallout>
        <p>Welcome aboard</p>
      </OnboardingCallout>
    );
    expect(screen.getByRole('note')).toHaveTextContent('Welcome aboard');
  });

  it('renders the title as a heading when provided', () => {
    render(<OnboardingCallout title="Getting started">body</OnboardingCallout>);
    expect(screen.getByRole('heading', { name: 'Getting started' })).toBeInTheDocument();
  });

  it('omits the heading when no title is given', () => {
    render(<OnboardingCallout>body</OnboardingCallout>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('omits the dismiss button when onDismiss is not provided', () => {
    render(<OnboardingCallout>body</OnboardingCallout>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onDismiss when the "Got it" button is clicked', async () => {
    const onDismiss = vi.fn();
    render(<OnboardingCallout onDismiss={onDismiss}>body</OnboardingCallout>);
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('appends a custom className without leaving stray whitespace', () => {
    const { rerender } = render(<OnboardingCallout className="extra">body</OnboardingCallout>);
    expect(screen.getByRole('note').className).toBe('onboarding-callout extra');
    rerender(<OnboardingCallout>body</OnboardingCallout>);
    expect(screen.getByRole('note').className).toBe('onboarding-callout');
  });
});
