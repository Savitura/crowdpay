import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import About from '../../pages/About';
import { renderWithProviders } from '../renderWithProviders';

describe('About page', () => {
  it('renders the about page heading and content', () => {
    renderWithProviders(<About />);

    expect(screen.getByRole('heading', { name: /About CrowdPay/i })).toBeInTheDocument();
    expect(
      screen.getByText(/CrowdPay is a fundraising platform built to move contributions/i)
    ).toBeInTheDocument();
  });
});
