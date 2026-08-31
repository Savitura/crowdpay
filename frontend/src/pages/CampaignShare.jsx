import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import CampaignQRCode from '../components/CampaignQRCode';

function shareTexts(campaignTitle, shareUrl) {
  return {
    twitter: `Backing ${campaignTitle} on CrowdPay — funded transparently on Stellar. Join me: ${shareUrl}`,
    whatsapp: `Hey! I'm supporting ${campaignTitle} on CrowdPay. Every contribution settles on Stellar in seconds — take a look: ${shareUrl}`,
    telegram: `${campaignTitle} is raising funds on CrowdPay, built on Stellar. Here's the link: ${shareUrl}`,
  };
}

export default function CampaignShare() {
  const { id } = useParams();
  const { user, ready } = useAuth();
  const [campaign, setCampaign] = useState(null);
  const [program, setProgram] = useState(null);
  const [link, setLink] = useState(null);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [copied, setCopied] = useState('');
  const [embedTheme, setEmbedTheme] = useState('light');
  const [embedSize, setEmbedSize] = useState('medium');

  useEffect(() => {
    if (!id) return;
    api.getCampaign(id).then(setCampaign).catch(() => setCampaign(null));
    api.getReferralProgram(id).then(setProgram).catch(() => setProgram(null));
  }, [id]);

  const claimLink = useCallback(async () => {
    setClaiming(true);
    setError('');
    try {
      setLink(await api.createReferralLink(id));
    } catch (err) {
      setError(
        err.message === 'REFERRER_LIMIT_REACHED'
          ? 'This campaign has reached its referrer limit.'
          : err.message || 'Could not create your referral link'
      );
    } finally {
      setClaiming(false);
    }
  }, [id]);

  const copy = useCallback(async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setError('Could not copy to clipboard');
    }
  }, []);

  if (!ready) return null;

  const campaignUrl = `${window.location.origin}/campaigns/${id}`;
  const shareUrl = link?.shareUrl || campaignUrl;
  const texts = shareTexts(campaign?.title || 'this campaign', shareUrl);

  const embedScript = `<script src="${window.location.origin}/embed-widget.js" data-campaign="${id}" data-theme="${embedTheme}" data-size="${embedSize}"></script>`;

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>Share {campaign?.title || 'campaign'}</h1>
      <p style={{ color: 'var(--color-text-muted)', marginTop: 0 }}>
        {program
          ? `Referrers earn ${Number(program.commission_percentage)}% of every contribution made through their link.`
          : 'Share this campaign with your network.'}
      </p>

      {program && !link && (
        <div className="campaign-card" style={{ marginBottom: '1.25rem' }}>
          {user ? (
            <>
              <p style={{ marginTop: 0 }}>
                Claim your personal referral link to earn commission on the contributions you bring in.
              </p>
              <button type="button" className="btn-primary" onClick={claimLink} disabled={claiming}>
                {claiming ? 'Creating…' : 'Get my referral link'}
              </button>
            </>
          ) : (
            <p style={{ margin: 0 }}>
              <Link to="/login">Log in</Link> to claim a referral link for this campaign.
            </p>
          )}
        </div>
      )}

      {error && <p style={{ color: 'var(--color-danger)' }}>{error}</p>}

      <div className="campaign-card" style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.25rem' }}>
        <strong>{link ? 'Your referral link' : 'Campaign link'}</strong>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            readOnly
            value={shareUrl}
            aria-label="Share URL"
            style={{ flex: '1 1 20rem', padding: '0.45rem 0.6rem', fontFamily: 'monospace', fontSize: '0.82rem' }}
          />
          <button type="button" className="btn-secondary" onClick={() => copy(shareUrl, 'url')}>
            {copied === 'url' ? 'Copied!' : 'Copy link'}
          </button>
        </div>
      </div>

      <div className="campaign-card" style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.25rem' }}>
        <strong>Get Embed Code</strong>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
          Embed a real-time contribution progress widget on your website or blog.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            Theme:
            <select value={embedTheme} onChange={(e) => setEmbedTheme(e.target.value)} style={{ padding: '0.2rem' }}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            Size:
            <select value={embedSize} onChange={(e) => setEmbedSize(e.target.value)} style={{ padding: '0.2rem' }}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <textarea
            readOnly
            rows={3}
            value={embedScript}
            aria-label="Embed Code"
            style={{ flex: '1 1 20rem', padding: '0.45rem 0.6rem', fontFamily: 'monospace', fontSize: '0.78rem' }}
          />
          <button type="button" className="btn-secondary" onClick={() => copy(embedScript, 'embed')}>
            {copied === 'embed' ? 'Copied!' : 'Copy embed code'}
          </button>
        </div>
      </div>

      <div className="campaign-card" style={{ marginBottom: '1.25rem' }}>
        <strong style={{ display: 'block', marginBottom: '0.5rem' }}>QR Code</strong>
        <CampaignQRCode url={shareUrl} size={160} />
      </div>

      <div className="campaign-card" style={{ display: 'grid', gap: '0.75rem' }}>
        <strong>Share on social media</strong>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(texts.twitter)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
          >
            Twitter / X
          </a>
          <a
            href={`https://api.whatsapp.com/send?text=${encodeURIComponent(texts.whatsapp)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
          >
            WhatsApp
          </a>
          <a
            href={`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(texts.telegram)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
          >
            Telegram
          </a>
        </div>
      </div>
    </div>
  );
}