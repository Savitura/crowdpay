import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import Campaign from '../../pages/Campaign';
import { renderWithProviders } from '../renderWithProviders';

const baseCampaign = {
  id: 'camp-seo-1',
  title: 'Solar Microgrid for Rural Schools',
  description: 'Bringing clean solar electricity to 12 rural classrooms.',
  target_amount: 10000,
  raised_amount: 4500,
  asset_type: 'USDC',
  status: 'active',
  is_hidden: false,
  creator_id: 'user-creator',
  cover_image_url: 'https://cdn.example.com/covers/solar.png',
  og_image_url: 'https://api.example.com/api/campaigns/camp-seo-1/og-image.png',
};

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'camp-seo-1' }),
    useLocation: () => ({ pathname: '/campaigns/camp-seo-1', search: '', hash: '', state: null }),
  };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    token: null,
    ready: true,
  }),
}));

const apiProxy = vi.hoisted(
  () =>
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
                'getMilestones',
                'getWithdrawals',
                'getCampaignFulfillments',
              ].includes(prop)
            ) {
              target[prop] = vi.fn().mockResolvedValue([]);
            } else if (prop === 'getContributions') {
              target[prop] = vi.fn().mockResolvedValue({ contributions: [], total: 0 });
            } else if (prop === 'getCampaign') {
              target[prop] = vi.fn().mockResolvedValue(baseCampaign);
            } else if (prop === 'getExchangeRates') {
              target[prop] = vi.fn().mockResolvedValue({
                target: 'NGN',
                rates: { USDC: 1600, XLM: 160 },
                approximate: true,
              });
            } else {
              target[prop] = vi.fn().mockResolvedValue({});
            }
          }
          return target[prop];
        },
      }
    )
);

vi.mock('../../services/api', () => ({
  api: apiProxy,
  apiClient: {
    get: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

function getMeta(name, property = false) {
  const el = document.querySelector(
    property ? `meta[property="${name}"]` : `meta[name="${name}"]`
  );
  return el ? el.getAttribute('content') : null;
}

describe('Campaign page OpenGraph and SEO metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.head.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"], meta[name="description"]').forEach((el) => el.remove());
    document.title = 'CrowdPay';
  });

  it('renders OG and Twitter meta tags cleanly for public campaigns with cover_image_url', async () => {
    apiProxy.getCampaign.mockResolvedValueOnce(baseCampaign);
    renderWithProviders(<Campaign />);

    await waitFor(() => {
      expect(document.title).toBe('Solar Microgrid for Rural Schools | CrowdPay');
    });

    expect(getMeta('description')).toBe(baseCampaign.description);
    expect(getMeta('og:type', true)).toBe('website');
    expect(getMeta('og:title', true)).toBe(baseCampaign.title);
    expect(getMeta('og:description', true)).toBe(baseCampaign.description);
    expect(getMeta('og:image', true)).toBe(baseCampaign.cover_image_url);
    expect(getMeta('twitter:card')).toBe('summary_large_image');
    expect(getMeta('twitter:title')).toBe(baseCampaign.title);
    expect(getMeta('twitter:description')).toBe(baseCampaign.description);
    expect(getMeta('twitter:image')).toBe(baseCampaign.cover_image_url);
  });

  it('falls back to og_image_url when cover_image_url is not set', async () => {
    apiProxy.getCampaign.mockResolvedValueOnce({
      ...baseCampaign,
      cover_image_url: null,
    });
    renderWithProviders(<Campaign />);

    await waitFor(() => {
      expect(getMeta('og:image', true)).toBe(baseCampaign.og_image_url);
    });
    expect(getMeta('twitter:image')).toBe(baseCampaign.og_image_url);
    expect(getMeta('twitter:card')).toBe('summary_large_image');
  });

  it('falls back gracefully to default metadata for private/hidden campaigns', async () => {
    // Seed stale OG image tag to ensure it is cleared
    const stale = document.createElement('meta');
    stale.setAttribute('property', 'og:image');
    stale.setAttribute('content', 'https://cdn.example.com/stale.png');
    document.head.appendChild(stale);

    apiProxy.getCampaign.mockResolvedValueOnce({
      ...baseCampaign,
      is_hidden: true,
    });
    renderWithProviders(<Campaign />);

    await waitFor(() => {
      expect(getMeta('og:title', true)).toBe('CrowdPay');
    });

    expect(document.title).toBe('CrowdPay');
    expect(getMeta('og:description', true)).toBe('Support transparent crowdfunding campaigns on CrowdPay.');
    expect(getMeta('og:image', true)).toBeNull();
    expect(getMeta('twitter:image')).toBeNull();
    expect(getMeta('twitter:card')).toBe('summary');
  });

  it('falls back gracefully to default metadata for missing campaigns', async () => {
    apiProxy.getCampaign.mockRejectedValueOnce(new Error('Campaign not found'));
    renderWithProviders(<Campaign />);

    await waitFor(() => {
      expect(getMeta('og:title', true)).toBe('CrowdPay');
    });

    expect(document.title).toBe('CrowdPay');
    expect(getMeta('og:description', true)).toBe('Support transparent crowdfunding campaigns on CrowdPay.');
    expect(getMeta('og:image', true)).toBeNull();
    expect(getMeta('twitter:image')).toBeNull();
    expect(getMeta('twitter:card')).toBe('summary');
  });
});
