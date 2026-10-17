import React, { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';

/**
 * ImpactReportDisplay — Shows published impact report on campaign page.
 * Prominently displayed post-completion.
 * Includes: report content, image gallery, milestone list, share buttons.
 * Has impact badge showing the creator published a report.
 */
export function ImpactReportDisplay({ report, campaignTitle }) {
  if (!report) {
    return null;
  }

  function escapeHtml(text) {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function markdownToHtml(markdown) {
    const escaped = escapeHtml(markdown || '');
    return escaped
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(
        /\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      )
      .replace(/\n/g, '<br />');
  }

  const htmlContent = markdownToHtml(report.content);

  return (
    <section
      aria-labelledby="impact-report-heading"
      style={{
        marginTop: '2rem',
        padding: '1.5rem',
        backgroundColor: 'var(--color-bg-alt)',
        border: '2px solid var(--color-accent-light)',
        borderRadius: '0.75rem',
      }}
      id="impact-report"
    >
      {/* Impact Badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '1rem',
        }}
      >
        <span style={{ fontSize: '1.5rem' }} aria-hidden="true">
          🏆
        </span>
        <span
          style={{
            fontSize: '0.85rem',
            fontWeight: '600',
            color: 'var(--color-accent)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          Impact Report Published
        </span>
      </div>

      {/* Report Title */}
      <h2
        id="impact-report-heading"
        style={{
          fontSize: '1.5rem',
          marginBottom: '0.5rem',
          color: 'var(--color-text)',
        }}
      >
        {report.title}
      </h2>

      {/* Report Summary */}
      {report.summary && (
        <p
          style={{
            fontSize: '0.95rem',
            color: 'var(--color-text-hint)',
            marginBottom: '1.5rem',
            fontStyle: 'italic',
          }}
        >
          {report.summary}
        </p>
      )}

      {/* Published Date */}
      <p
        style={{
          fontSize: '0.85rem',
          color: 'var(--color-text-hint)',
          marginBottom: '1.5rem',
        }}
      >
        Published on{' '}
        {new Date(report.publishedAt).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}
      </p>

      {/* Rendered Markdown Content */}
      <div
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(htmlContent),
        }}
        style={{
          lineHeight: 1.7,
          color: 'var(--color-text)',
          marginBottom: '2rem',
        }}
      />

      {/* Image Gallery */}
      {report.images && report.images.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>📸 Gallery</h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '1rem',
            }}
          >
            {report.images
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map((img, idx) => (
                <figure
                  key={idx}
                  style={{
                    margin: 0,
                    overflow: 'hidden',
                    borderRadius: '0.5rem',
                  }}
                >
                  <img
                    src={img.url}
                    alt={img.caption || `Impact report image ${idx + 1}`}
                    style={{
                      width: '100%',
                      height: '200px',
                      objectFit: 'cover',
                      display: 'block',
                    }}
                  />
                  {img.caption && (
                    <figcaption
                      style={{
                        padding: '0.5rem',
                        backgroundColor: 'white',
                        fontSize: '0.85rem',
                        color: 'var(--color-text-hint)',
                        textAlign: 'center',
                      }}
                    >
                      {img.caption}
                    </figcaption>
                  )}
                </figure>
              ))}
          </div>
        </div>
      )}

      {/* Videos */}
      {report.videos && report.videos.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <h3 style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>🎬 Videos</h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: '1rem',
            }}
          >
            {report.videos.map((video, idx) => (
              <div
                key={idx}
                style={{
                  borderRadius: '0.5rem',
                  overflow: 'hidden',
                  backgroundColor: '#000',
                }}
              >
                {video.thumbnail && (
                  <a
                    href={video.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'block' }}
                  >
                    <img
                      src={video.thumbnail}
                      alt={video.title || `Video ${idx + 1}`}
                      style={{
                        width: '100%',
                        height: '200px',
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        color: 'white',
                        fontSize: '3rem',
                        opacity: 0.8,
                      }}
                    >
                      ▶️
                    </div>
                  </a>
                )}
                {video.title && (
                  <div
                    style={{
                      padding: '0.75rem',
                      backgroundColor: 'white',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                    }}
                  >
                    <a
                      href={video.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: 'var(--color-accent)',
                        textDecoration: 'none',
                      }}
                    >
                      {video.title} →
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Milestones List */}
      {report.milestones && report.milestones.length > 0 && (
        <div
          style={{
            padding: '1.5rem',
            backgroundColor: 'white',
            borderRadius: '0.5rem',
            marginBottom: '1rem',
          }}
        >
          <h3
            style={{
              fontSize: '1.1rem',
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span>🎯</span> Milestones Achieved
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {report.milestones.map((milestone, idx) => (
              <li
                key={idx}
                style={{
                  padding: '1rem',
                  borderLeft: '4px solid var(--color-accent)',
                  backgroundColor: 'var(--color-bg-alt)',
                  marginBottom: idx < report.milestones.length - 1 ? '0.75rem' : 0,
                  borderRadius: '0.25rem',
                }}
              >
                <div
                  style={{ fontWeight: '600', color: 'var(--color-text)', marginBottom: '0.25rem' }}
                >
                  ✓ {milestone.title}
                </div>
                {milestone.description && (
                  <div style={{ fontSize: '0.9rem', color: 'var(--color-text-hint)' }}>
                    {milestone.description}
                  </div>
                )}
                {milestone.achievedAt && (
                  <div
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--color-text-hint)',
                      marginTop: '0.25rem',
                    }}
                  >
                    Achieved on {new Date(milestone.achievedAt).toLocaleDateString()}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Share Buttons */}
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          marginTop: '1.5rem',
          padding: '1rem 0',
          borderTop: '1px solid var(--color-border)',
        }}
      >
        <span
          style={{ fontSize: '0.85rem', fontWeight: '500', display: 'flex', alignItems: 'center' }}
        >
          Share this report:
        </span>
        <a
          href={`https://twitter.com/intent/tweet?text=Check out the impact report from ${campaignTitle}: ${window.location.href}%23impact-report&via=CrowdPay`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.4rem 0.75rem',
            backgroundColor: '#1DA1F2',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '0.35rem',
            fontSize: '0.85rem',
            fontWeight: '500',
          }}
        >
          𝕏
        </a>
        <a
          href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.4rem 0.75rem',
            backgroundColor: '#1877F2',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '0.35rem',
            fontSize: '0.85rem',
            fontWeight: '500',
          }}
        >
          f
        </a>
        <a
          href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(window.location.href)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.4rem 0.75rem',
            backgroundColor: '#0A66C2',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '0.35rem',
            fontSize: '0.85rem',
            fontWeight: '500',
          }}
        >
          in
        </a>
      </div>

      {/* View Count */}
      <div style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
        {report.viewsCount} {report.viewsCount === 1 ? 'view' : 'views'}
      </div>
    </section>
  );
}

export default ImpactReportDisplay;
