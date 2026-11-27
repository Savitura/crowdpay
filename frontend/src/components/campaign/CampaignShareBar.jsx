import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { api } from '../../services/api';

export default function CampaignShareBar({ campaign, referralUrl, toast }) {
  const [linkCopied, setLinkCopied] = useState(false);

  if (!campaign) return null;

  return (
    <div
      data-no-print
      style={{
        display: 'flex',
        gap: '0.65rem',
        marginBottom: '1.75rem',
        flexWrap: 'wrap',
      }}
    >
      {typeof navigator !== 'undefined' && navigator.share && (
        <button
          type="button"
          className="btn-secondary"
          style={{
            flex: 1,
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
          }}
          onClick={async () => {
            try {
              api.trackShare(campaign.id, 'native').catch(() => {});
              await navigator.share({
                title: campaign.title,
                text: campaign.description,
                url: referralUrl || window.location.href,
              });
            } catch (err) {
              if (err.name !== 'AbortError') {
                toast?.('Could not share this campaign. Please try again.', 'error');
                Sentry.captureException(err);
              }
            }
          }}
        >
          Share
        </button>
      )}
      <button
        type="button"
        className="btn-secondary"
        style={{
          flex: 1,
          fontSize: '0.85rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
        }}
        onClick={() => {
          api.trackShare(campaign.id, 'twitter').catch(() => {});
          const shareUrl = referralUrl || window.location.href;
          const pct = Math.min(
            100,
            (campaign.raised_amount / campaign.target_amount) * 100
          ).toFixed(1);
          const daysLeft = Math.max(
            0,
            Math.ceil((new Date(campaign.end_date) - new Date()) / (1000 * 60 * 60 * 24))
          );
          const text = encodeURIComponent(
            `Back ${campaign.title} on CrowdPay - ${pct}% funded, ${daysLeft} days left. Built on Stellar. ${shareUrl} #Stellar #CrowdPay`
          );
          window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank');
        }}
        aria-label="Share on X"
      >
        Share on X
      </button>
      <button
        type="button"
        className="btn-secondary"
        style={{
          flex: 1,
          fontSize: '0.85rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
        }}
        onClick={() => {
          api.trackShare(campaign.id, 'whatsapp').catch(() => {});
          const shareUrl = referralUrl || window.location.href;
          const pct = Math.min(
            100,
            (campaign.raised_amount / campaign.target_amount) * 100
          ).toFixed(1);
          const text = encodeURIComponent(
            `Hey! Check out this campaign on CrowdPay: ${campaign.title}. They are ${pct}% funded and need your help. ${shareUrl}`
          );
          window.open(`https://wa.me/?text=${text}`, '_blank');
        }}
        aria-label="Share on WhatsApp"
      >
        WhatsApp
      </button>
      <button
        type="button"
        className="btn-secondary"
        style={{
          flex: 1,
          fontSize: '0.85rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
        }}
        onClick={() => {
          api.trackShare(campaign.id, 'linkedin').catch(() => {});
          const shareUrl = referralUrl || window.location.href;
          const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`;
          window.open(linkedInUrl, '_blank');
        }}
        aria-label="Share on LinkedIn"
      >
        LinkedIn
      </button>
      <button
        type="button"
        className="btn-secondary"
        style={{
          flex: 1,
          fontSize: '0.85rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
        }}
        onClick={() => {
          api.trackShare(campaign.id, 'telegram').catch(() => {});
          const shareUrl = referralUrl || window.location.href;
          const text = encodeURIComponent(`Check out this campaign: ${campaign.title}`);
          window.open(
            `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${text}`,
            '_blank'
          );
        }}
        aria-label="Share on Telegram"
      >
        Telegram
      </button>
      <button
        type="button"
        className="btn-secondary"
        style={{
          flex: 1,
          fontSize: '0.85rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
        }}
        onClick={() => {
          api.trackShare(campaign.id, 'discord').catch(() => {});
          navigator.clipboard.writeText(referralUrl || window.location.href);
          toast?.('Link copied! Paste it in Discord to share.', 'success');
          setTimeout(() => window.open('https://discord.com/app', '_blank'), 1500);
        }}
        aria-label="Share on Discord"
      >
        Discord
      </button>
      <div style={{ position: 'relative', flex: 1 }}>
        <button
          type="button"
          className="btn-secondary"
          style={{
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            width: '100%',
            background: linkCopied ? 'var(--color-success-text)' : undefined,
            borderColor: linkCopied ? 'var(--color-success-text)' : undefined,
            color: linkCopied ? 'var(--color-bg)' : undefined,
            transition: 'all 0.2s ease',
          }}
          onClick={() => {
            api.trackShare(campaign.id, 'copy').catch(() => {});
            navigator.clipboard.writeText(referralUrl || window.location.href);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
          }}
        >
          {linkCopied ? 'Copied!' : 'Copy link'}
        </button>

        <Link
          to={`/campaigns/${campaign.id}/share`}
          className="btn-secondary"
          style={{
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            width: '100%',
            textDecoration: 'none',
          }}
        >
          Share page &amp; referral link
        </Link>
      </div>
    </div>
  );
}
