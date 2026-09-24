import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import Campaign from '../../pages/Campaign';
import { renderWithProviders } from '../renderWithProviders';

const mockUser = { id: 'user-creator', role: 'creator', email: 'creator@example.com' };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'camp-123' }),
  };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    token: 'fake-token',
    ready: true,
  }),
}));

const apiProxy = vi.hoisted(() =>
  new Proxy(
    {},
    {
      get: (target, prop) => {
        if (!target[prop]) {
          if (
            [
              'getCampaignUpdates',
              'getCampaignMembers',
              'getCampaignTiers',
              'getStretchGoals',
              'listWithdrawals',
              'getComments',
              'getCampaignTranslations',
            ].includes(prop)
          ) {
            target[prop] = vi.fn().mockResolvedValue([]);
          } else if (prop === 'getContributions') {
            target[prop] = vi.fn().mockResolvedValue({ contributions: [], total: 0 });
          } else {
            target[prop] = vi.fn().mockResolvedValue({});
          }
        }
        return target[prop];
      },
    }
  )
);

vi.mock('../../services/api', () => ({ api: apiProxy }));

describe('Campaign Translations UI & Logic', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes locale query parameter to api.getCampaign and api.getMilestones', async () => {
    apiProxy.getCampaign.mockResolvedValue({
      id: 'camp-123',
      creator_id: 'user-creator',
      user_role: 'owner',
      title: 'English Title',
      description: 'English Description',
      status: 'active',
      current_amount: '0',
      target_amount: '1000',
      asset_type: 'USDC',
      wallet_mode: 'standard',
    });
    apiProxy.getMilestones.mockResolvedValue([
      { id: 'm1', title: 'Milestone 1', description: 'Desc 1', release_percentage: 100 },
    ]);
    apiProxy.getCampaignTranslations.mockResolvedValue([]);

    renderWithProviders(<Campaign />);

    await waitFor(() => {
      expect(apiProxy.getCampaign).toHaveBeenCalledWith(
        'camp-123',
        expect.objectContaining({
          locale: expect.any(String),
        })
      );
      expect(apiProxy.getMilestones).toHaveBeenCalledWith(
        'camp-123',
        expect.objectContaining({
          locale: expect.any(String),
        })
      );
    });
  });

  it('allows creator to open edit modal and manage translations', async () => {
    apiProxy.getCampaign.mockResolvedValue({
      id: 'camp-123',
      creator_id: 'user-creator',
      user_role: 'owner',
      title: 'Original Title',
      description: 'Original Description',
      status: 'active',
      current_amount: '0',
      target_amount: '1000',
      asset_type: 'USDC',
      wallet_mode: 'standard',
    });
    apiProxy.getMilestones.mockResolvedValue([]);
    apiProxy.getCampaignTranslations.mockResolvedValue([
      { locale: 'fr', title: 'Titre Français', description: 'Description Française' },
    ]);
    apiProxy.saveCampaignTranslation.mockResolvedValue({
      id: 't-es',
      locale: 'es',
      title: 'Título Español',
      description: 'Descripción Española',
    });

    renderWithProviders(<Campaign />);

    const editBtn = await screen.findByRole('button', { name: /Edit Campaign/i });
    fireEvent.click(editBtn);

    // Edit modal should show translations section
    expect(await screen.findByText('Translations')).toBeInTheDocument();

    // Already translated FR button should say "✓ Edit French (Français)"
    expect(screen.getByRole('button', { name: /✓ Edit French \(Français\)/i })).toBeInTheDocument();

    // Untranslated ES button should say "+ Add Translation (Spanish (Español))"
    const addEsBtn = screen.getByRole('button', { name: /\+ Add Translation \(Spanish \(Español\)\)/i });
    fireEvent.click(addEsBtn);

    // Filling in the translation
    const titleInput = screen.getByPlaceholderText(/Title in selected language/i);
    fireEvent.change(titleInput, { target: { value: 'Título Español' } });

    const descInput = screen.getByPlaceholderText(/Description in selected language/i);
    fireEvent.change(descInput, { target: { value: 'Descripción Española' } });

    const saveTransBtn = screen.getByRole('button', { name: /Save Translation/i });
    fireEvent.click(saveTransBtn);

    await waitFor(() => {
      expect(apiProxy.saveCampaignTranslation).toHaveBeenCalledWith(
        'camp-123',
        expect.objectContaining({
          locale: 'es',
          title: 'Título Español',
          description: 'Descripción Española',
        })
      );
    });
  });
});
