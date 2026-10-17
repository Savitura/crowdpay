import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MilestoneProgressBar, { normalizeWidgetSize } from '../../components/MilestoneProgressBar';

const MILESTONES = [
  { id: 'm-1', title: 'Design', release_percentage: 25, status: 'released' },
  { id: 'm-2', title: 'Build', release_percentage: 25, status: 'approved' },
  { id: 'm-3', title: 'Install', release_percentage: 25, status: 'submitted' },
  { id: 'm-4', title: 'Handover', release_percentage: 25, status: 'pending' },
];

const SUMMARY = {
  total: 4,
  released: 1,
  approved: 1,
  submitted: 1,
  pending: 1,
  released_percentage: 25,
};

describe('MilestoneProgressBar', () => {
  it('falls back to the medium size for unknown values', () => {
    expect(normalizeWidgetSize('large')).toBe('large');
    expect(normalizeWidgetSize('huge')).toBe('medium');
    expect(normalizeWidgetSize(null)).toBe('medium');
  });

  it('shows how many milestones have been released', () => {
    render(<MilestoneProgressBar milestones={MILESTONES} summary={SUMMARY} />);

    expect(screen.getByText('1 of 4 released')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '1 of 4 milestones released' })).toBeInTheDocument();
  });

  it('lists every milestone with its status at the large size', () => {
    render(<MilestoneProgressBar milestones={MILESTONES} summary={SUMMARY} size="large" />);

    expect(screen.getByText('Released')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Handover')).toBeInTheDocument();
  });

  it('renders nothing at the small size or without milestones', () => {
    const { container: small } = render(
      <MilestoneProgressBar milestones={MILESTONES} summary={SUMMARY} size="small" />
    );
    expect(small).toBeEmptyDOMElement();

    const { container: none } = render(<MilestoneProgressBar milestones={[]} summary={null} />);
    expect(none).toBeEmptyDOMElement();
  });
});
