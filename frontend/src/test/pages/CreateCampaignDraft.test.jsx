import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import CreateCampaign from '../../pages/CreateCampaign';
import { renderWithProviders } from '../renderWithProviders';

vi.mock('react-simplemde-editor', () => ({
  default: ({ id, value, onChange }) => (
    <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user1', role: 'creator', kyc_status: 'verified' },
    ready: true,
    updateUser: vi.fn(),
  }),
}));

const apiMocks = vi.hoisted(() => ({
  getMe: vi.fn().mockResolvedValue({ id: 'user1', role: 'creator' }),
  checkDuplicateCampaign: vi.fn().mockResolvedValue({ isDuplicate: false }),
  createCampaign: vi.fn().mockResolvedValue({ id: 'new-campaign' }),
  uploadCampaignCoverImage: vi.fn().mockResolvedValue({}),
  getCampaignTemplates: vi.fn().mockResolvedValue([]),
  getMyCampaignDraft: vi.fn().mockResolvedValue(null),
  saveCampaignDraft: vi
    .fn()
    .mockResolvedValue({ id: 'draft-1', saved_at: new Date().toISOString() }),
  deleteCampaignDraft: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

const STORAGE_KEY = 'crowdpay:campaign_draft';

function storedDraft() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

describe('CreateCampaign draft auto-save', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    window.history.replaceState({}, '');
  });

  it('auto-saves edits and shows a saved indicator', async () => {
    let resolveServerSave;
    apiMocks.saveCampaignDraft.mockReturnValue(
      new Promise((resolve) => {
        resolveServerSave = resolve;
      })
    );

    renderWithProviders(<CreateCampaign />);

    const title = await screen.findByLabelText(/Campaign title/i);

    vi.useFakeTimers();

    fireEvent.change(title, { target: { value: 'Solar grid' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByText(/Saving draft/i)).toBeInTheDocument();
    expect(storedDraft()?.form.title).toBe('Solar grid');

    await act(async () => {
      resolveServerSave({ id: 'draft-1', saved_at: new Date().toISOString() });
    });

    expect(screen.getByText(/Draft saved/i)).toBeInTheDocument();
  });

  it('does not save an untouched form', async () => {
    renderWithProviders(<CreateCampaign />);

    await screen.findByLabelText(/Campaign title/i);

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(storedDraft()).toBeNull();
  });

  it('offers to restore a stored draft and reinstates its values', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        form: {
          title: 'Recovered campaign',
          description: '',
          target_amount: '900',
          asset_type: 'XLM',
          deadline: '',
          category: '',
          min_contribution: '',
          max_contribution: '',
          max_per_user: '',
          show_backer_amounts: true,
          milestones: [],
          reward_tiers: [],
        },
        step: 1,
        saved_at: new Date().toISOString(),
      })
    );

    renderWithProviders(<CreateCampaign />);

    fireEvent.click(await screen.findByRole('button', { name: /Restore draft/i }));

    expect(screen.getByLabelText(/Campaign title/i)).toHaveValue('Recovered campaign');
    expect(screen.getByLabelText(/Fundraising goal/i)).toHaveValue(900);
  });

  it('discards a stored draft without touching the form', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        form: { title: 'Abandoned campaign', milestones: [], reward_tiers: [] },
        step: 1,
        saved_at: new Date().toISOString(),
      })
    );

    renderWithProviders(<CreateCampaign />);

    fireEvent.click(await screen.findByRole('button', { name: /Discard draft/i }));

    expect(storedDraft()).toBeNull();
    expect(screen.getByLabelText(/Campaign title/i)).toHaveValue('');
  });

  it('clears the draft once the campaign is created', async () => {
    renderWithProviders(<CreateCampaign />);

    fireEvent.change(await screen.findByLabelText(/Campaign title/i), {
      target: { value: 'Solar grid' },
    });
    fireEvent.change(screen.getByLabelText(/Fundraising goal/i), { target: { value: '500' } });
    await waitFor(() => expect(storedDraft()).not.toBeNull(), { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: /Continue to details/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Continue to milestones/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Launch campaign/i }));

    await waitFor(() => expect(apiMocks.createCampaign).toHaveBeenCalled());
    await waitFor(() => expect(storedDraft()).toBeNull());
  });
});
