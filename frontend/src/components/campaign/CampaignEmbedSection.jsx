import React, { useState } from 'react';

export default function CampaignEmbedSection({
  campaignId,
  widgetEmbedCode = '',
  fullEmbedCode = '',
  badgeMarkdown = '',
  canPostUpdate = false,
}) {
  const [showEmbedSection, setShowEmbedSection] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [badgeCopied, setBadgeCopied] = useState(false);
  const [fullEmbedCopied, setFullEmbedCopied] = useState(false);

  return (
    <>
      <details style={{ ...styles.card, marginTop: '-0.75rem' }}>
        <summary style={styles.embedSummary}>Embed on your site</summary>
        <pre style={{ ...styles.embedCode, marginTop: '0.75rem' }}>{widgetEmbedCode}</pre>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(widgetEmbedCode).then(() => {
              setEmbedCopied(true);
              setTimeout(() => setEmbedCopied(false), 2000);
            });
          }}
          className="btn-secondary"
          style={{ marginTop: '0.75rem', fontSize: '0.85rem', minHeight: 'auto' }}
        >
          {embedCopied ? 'Copied!' : 'Copy snippet'}
        </button>
      </details>

      {canPostUpdate && (
        <div style={styles.card} data-no-print>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Embed this campaign</h3>
            <button
              type="button"
              aria-expanded={showEmbedSection}
              onClick={() => setShowEmbedSection(!showEmbedSection)}
              style={{
                background: 'transparent',
                color: 'var(--color-accent)',
                border: '1px solid var(--color-accent)',
                padding: '0.4rem 0.8rem',
                fontSize: '0.85rem',
                minHeight: 'auto',
              }}
            >
              {showEmbedSection ? 'Hide' : 'Show'}
            </button>
          </div>

          {showEmbedSection && (
            <>
              <p
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-hint)',
                  marginBottom: '1rem',
                  lineHeight: 1.5,
                }}
              >
                Add this embed code to your website or blog to display a live funding widget for
                this campaign.
              </p>

              <div style={{ marginBottom: '1rem' }}>
                <label
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: 'var(--color-text-hint)',
                    display: 'block',
                    marginBottom: '0.5rem',
                  }}
                >
                  Compact widget (iframe)
                </label>
                <div style={{ position: 'relative' }}>
                  <pre style={styles.embedCode}>{widgetEmbedCode}</pre>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(widgetEmbedCode).then(() => {
                        setEmbedCopied(true);
                        setTimeout(() => setEmbedCopied(false), 2000);
                      });
                    }}
                    style={{
                      position: 'absolute',
                      top: '0.5rem',
                      right: '0.5rem',
                      background: embedCopied ? 'var(--color-success-text)' : 'var(--color-accent)',
                      color: '#fff',
                      padding: '0.4rem 0.8rem',
                      fontSize: '0.8rem',
                      minHeight: 'auto',
                    }}
                  >
                    {embedCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: 'var(--color-text-hint)',
                    display: 'block',
                    marginBottom: '0.5rem',
                  }}
                >
                  Full embed (iframe)
                </label>
                <div style={{ position: 'relative' }}>
                  <pre style={styles.embedCode}>{fullEmbedCode}</pre>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(fullEmbedCode).then(() => {
                        setFullEmbedCopied(true);
                        setTimeout(() => setFullEmbedCopied(false), 2000);
                      });
                    }}
                    style={{
                      position: 'absolute',
                      top: '0.5rem',
                      right: '0.5rem',
                      background: fullEmbedCopied
                        ? 'var(--color-success-text)'
                        : 'var(--color-accent)',
                      color: '#fff',
                      padding: '0.4rem 0.8rem',
                      fontSize: '0.8rem',
                      minHeight: 'auto',
                    }}
                  >
                    {fullEmbedCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: 'var(--color-text-hint)',
                    display: 'block',
                    marginBottom: '0.5rem',
                  }}
                >
                  README badge (markdown)
                </label>
                <div style={{ position: 'relative' }}>
                  <pre style={styles.embedCode}>{badgeMarkdown}</pre>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(badgeMarkdown).then(() => {
                        setBadgeCopied(true);
                        setTimeout(() => setBadgeCopied(false), 2000);
                      });
                    }}
                    style={{
                      position: 'absolute',
                      top: '0.5rem',
                      right: '0.5rem',
                      background: badgeCopied ? 'var(--color-success-text)' : 'var(--color-accent)',
                      color: '#fff',
                      padding: '0.4rem 0.8rem',
                      fontSize: '0.8rem',
                      minHeight: 'auto',
                    }}
                  >
                    {badgeCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div>
                <label
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: 'var(--color-text-hint)',
                    display: 'block',
                    marginBottom: '0.5rem',
                  }}
                >
                  Preview
                </label>
                <div style={styles.embedPreview}>
                  <iframe
                    src={`/widget/campaigns/${campaignId}`}
                    width="100%"
                    height="140"
                    frameBorder="0"
                    title="Campaign widget preview"
                    style={{
                      border: '1px solid var(--color-border-light)',
                      borderRadius: '6px',
                    }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

const styles = {
  card: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '1.5rem',
    marginBottom: '1rem',
  },
  embedCode: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '6px',
    padding: '0.75rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    color: 'var(--color-text-primary)',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    paddingRight: '5rem',
  },
  embedSummary: {
    cursor: 'pointer',
    fontSize: '0.85rem',
    color: 'var(--color-accent)',
    fontWeight: 600,
  },
  embedPreview: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '6px',
    padding: '0.75rem',
  },
};
