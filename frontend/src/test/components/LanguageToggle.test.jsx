import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LanguageToggle from '../../components/LanguageToggle';

const apiMocks = vi.hoisted(() => ({
  getCampaignTranslations: vi.fn(),
}));

vi.mock('../../services/api', () => ({ api: apiMocks }));

describe('LanguageToggle component', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when no translations exist', async () => {
    apiMocks.getCampaignTranslations.mockResolvedValueOnce([]);

    const { container } = render(
      <LanguageToggle
        campaignId="c1"
        defaultLanguage="en"
        defaultTitle="English Title"
        defaultDescription="English Desc"
      />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('renders language buttons when translations exist and switches translation on click', async () => {
    apiMocks.getCampaignTranslations.mockResolvedValueOnce([
      { locale: 'fr', title: 'Titre Français', description: 'Description Française' },
      { locale: 'es', title: 'Título Español', description: 'Descripción Española' },
    ]);

    const onTranslationChange = vi.fn();

    render(
      <LanguageToggle
        campaignId="c1"
        defaultLanguage="en"
        defaultTitle="English Title"
        defaultDescription="English Desc"
        onTranslationChange={onTranslationChange}
      />
    );

    const frButton = await screen.findByRole('button', { name: /Français/i });
    expect(frButton).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Español/i })).toBeInTheDocument();

    fireEvent.click(frButton);

    await waitFor(() => {
      expect(onTranslationChange).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Titre Français',
          description: 'Description Française',
          language: 'fr',
        })
      );
    });
  });

  it('supports translations with language key instead of locale key', async () => {
    apiMocks.getCampaignTranslations.mockResolvedValueOnce([
      { language: 'de', title: 'Deutscher Titel', description: 'Deutsche Beschreibung' },
    ]);

    const onTranslationChange = vi.fn();

    render(
      <LanguageToggle
        campaignId="c1"
        defaultLanguage="en"
        defaultTitle="English Title"
        defaultDescription="English Desc"
        onTranslationChange={onTranslationChange}
      />
    );

    const deButton = await screen.findByRole('button', { name: /Deutsch/i });
    expect(deButton).toBeInTheDocument();

    fireEvent.click(deButton);

    await waitFor(() => {
      expect(onTranslationChange).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Deutscher Titel',
          description: 'Deutsche Beschreibung',
          language: 'de',
        })
      );
    });
  });
});
