import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import MilestoneVotePanel from './MilestoneVotePanel';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getMilestoneVotes: vi.fn(),
    voteMilestone: vi.fn(),
  },
}));

describe('MilestoneVotePanel component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders null when no pending_review milestones exist', () => {
    const milestones = [
      { id: 'm1', title: 'Milestone 1', status: 'approved' },
      { id: 'm2', title: 'Milestone 2', status: 'released' },
    ];

    const { container } = render(<MilestoneVotePanel milestones={milestones} />);
    expect(container.firstChild).toBeNull();
    expect(api.getMilestoneVotes).not.toHaveBeenCalled();
  });

  it('fetches and displays vote tallies for pending milestones', async () => {
    const milestones = [
      { id: 'm1', title: 'Phase 1 Delivery', status: 'pending_review' },
    ];

    api.getMilestoneVotes.mockResolvedValueOnce({
      approve_count: 5,
      reject_count: 2,
      user_vote: null,
    });

    render(<MilestoneVotePanel milestones={milestones} />);

    expect(screen.getByText('Phase 1 Delivery')).toBeInTheDocument();
    expect(screen.getByText('Vote tally loading')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('5 approve / 2 reject')).toBeInTheDocument();
    });

    expect(api.getMilestoneVotes).toHaveBeenCalledWith('m1');
  });

  it('submits an approve vote', async () => {
    const milestones = [
      { id: 'm1', title: 'Phase 1 Delivery', status: 'pending_review' },
    ];

    api.getMilestoneVotes.mockResolvedValueOnce({
      approve_count: 2,
      reject_count: 1,
      user_vote: null,
    });

    api.voteMilestone.mockResolvedValueOnce({
      approve_count: 3,
      reject_count: 1,
      user_vote: { vote: 'approve', note: '' },
    });

    render(<MilestoneVotePanel milestones={milestones} />);

    await screen.findByText('2 approve / 1 reject');

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(api.voteMilestone).toHaveBeenCalledWith('m1', { vote: 'approve', note: '' });
      expect(screen.getByText('3 approve / 1 reject')).toBeInTheDocument();
      expect(screen.getByText('Your vote: approve')).toBeInTheDocument();
    });
  });

  it('submits a reject vote with note', async () => {
    const milestones = [
      { id: 'm1', title: 'Phase 1 Delivery', status: 'pending_review' },
    ];

    api.getMilestoneVotes.mockResolvedValueOnce({
      approve_count: 4,
      reject_count: 0,
      user_vote: null,
    });

    api.voteMilestone.mockResolvedValueOnce({
      approve_count: 4,
      reject_count: 1,
      user_vote: { vote: 'reject', note: 'Incomplete proof' },
    });

    render(<MilestoneVotePanel milestones={milestones} />);

    await screen.findByText('4 approve / 0 reject');

    const noteInput = screen.queryByPlaceholderText(/note/i) || screen.queryByRole('textbox');
    if (noteInput) {
      fireEvent.change(noteInput, { target: { value: 'Incomplete proof' } });
    }

    const rejectBtn = screen.getByRole('button', { name: /reject/i });
    fireEvent.click(rejectBtn);

    await waitFor(() => {
      expect(api.voteMilestone).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({ vote: 'reject' })
      );
      expect(screen.getByText('Your vote: reject')).toBeInTheDocument();
    });
  });

  it('disables vote buttons when user has already voted', async () => {
    const milestones = [
      { id: 'm1', title: 'Phase 1 Delivery', status: 'pending_review' },
    ];

    api.getMilestoneVotes.mockResolvedValueOnce({
      approve_count: 10,
      reject_count: 1,
      user_vote: { vote: 'approve', note: 'Looks good' },
    });

    render(<MilestoneVotePanel milestones={milestones} />);

    await screen.findByText('Your vote: approve');

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    const rejectBtn = screen.getByRole('button', { name: /reject/i });

    expect(approveBtn).toBeDisabled();
    expect(rejectBtn).toBeDisabled();
  });

  it('handles vote loading failure', async () => {
    const milestones = [
      { id: 'm1', title: 'Phase 1 Delivery', status: 'pending_review' },
    ];

    api.getMilestoneVotes.mockRejectedValueOnce(new Error('Failed to load vote count'));

    render(<MilestoneVotePanel milestones={milestones} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load vote count')).toBeInTheDocument();
    });
  });

  it('handles vote submission failure', async () => {
    const milestones = [
      { id: 'm1', title: 'Phase 1 Delivery', status: 'pending_review' },
    ];

    api.getMilestoneVotes.mockResolvedValueOnce({
      approve_count: 2,
      reject_count: 1,
      user_vote: null,
    });

    api.voteMilestone.mockRejectedValueOnce(new Error('Unauthorized voter'));

    render(<MilestoneVotePanel milestones={milestones} />);

    await screen.findByText('2 approve / 1 reject');

    const approveBtn = screen.getByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByText('Unauthorized voter')).toBeInTheDocument();
    });
  });
});
