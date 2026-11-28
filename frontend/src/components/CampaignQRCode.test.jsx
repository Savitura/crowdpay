import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QRCode from 'qrcode';
import CampaignQRCode from './CampaignQRCode';

vi.mock('qrcode', () => ({
  default: {
    toCanvas: vi.fn(),
  },
}));

describe('CampaignQRCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a canvas and calls QRCode.toCanvas with the URL and default size', () => {
    const url = 'https://crowdpay.app/campaigns/abc-123';
    const { container } = render(<CampaignQRCode url={url} />);

    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
    expect(QRCode.toCanvas).toHaveBeenCalledTimes(1);
    expect(QRCode.toCanvas).toHaveBeenCalledWith(canvas, url, {
      width: 180,
      margin: 2,
      color: { dark: '#111111', light: '#ffffff' },
    });

    const downloadLink = screen.getByRole('link', { name: 'Download QR' });
    expect(downloadLink).toHaveAttribute('href', url);
    expect(downloadLink).toHaveAttribute('download', 'campaign-qr.png');
  });

  it('uses a custom size and re-renders QR when url or size changes', () => {
    const url1 = 'https://crowdpay.app/campaigns/first';
    const url2 = 'https://crowdpay.app/campaigns/second';
    const { container, rerender } = render(<CampaignQRCode url={url1} size={240} />);
    const canvas = container.querySelector('canvas');

    expect(QRCode.toCanvas).toHaveBeenLastCalledWith(canvas, url1, {
      width: 240,
      margin: 2,
      color: { dark: '#111111', light: '#ffffff' },
    });

    rerender(<CampaignQRCode url={url2} size={300} />);
    expect(QRCode.toCanvas).toHaveBeenCalledTimes(2);
    expect(QRCode.toCanvas).toHaveBeenLastCalledWith(canvas, url2, {
      width: 300,
      margin: 2,
      color: { dark: '#111111', light: '#ffffff' },
    });
  });

  it('does not invoke QRCode.toCanvas when url is empty or missing', () => {
    render(<CampaignQRCode url="" />);
    expect(QRCode.toCanvas).not.toHaveBeenCalled();
  });

  it('downloads the rendered canvas PNG when clicking Download QR', async () => {
    const user = userEvent.setup();
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const { container } = render(<CampaignQRCode url="https://crowdpay.app/campaigns/qr-1" />);
    const canvas = container.querySelector('canvas');
    canvas.toDataURL = vi.fn(() => dataUrl);

    const createdAnchor = { download: '', href: '', click: vi.fn() };
    const origCreateElement = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag === 'a') return createdAnchor;
      return origCreateElement(tag);
    });

    try {
      await user.click(screen.getByRole('link', { name: 'Download QR' }));
      expect(canvas.toDataURL).toHaveBeenCalledTimes(1);
      expect(createdAnchor.download).toBe('campaign-qr.png');
      expect(createdAnchor.href).toBe(dataUrl);
      expect(createdAnchor.click).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
    }
  });
});
