import React, { useState, useEffect, useCallback } from 'react';
import SimpleMDEEditor from 'react-simplemde-editor';
import DOMPurify from 'dompurify';
import 'easymde/dist/easymde.min.css';
import { api } from '../../services/api';
import { useToast } from '../../context/ToastContext';

/**
 * ImpactReportEditor — Rich content editor for campaign creators.
 * Allows writing markdown content, uploading images, adding video links,
 * and marking milestones achieved.
 *
 * Only visible to campaign creator on completed campaigns.
 * Renders a preview mode before publishing.
 */
export function ImpactReportEditor({ campaignId, existingReport, onPublished }) {
  const [tab, setTab] = useState('write');
  const [content, setContent] = useState(existingReport?.content ?? '');
  const [title, setTitle] = useState(existingReport?.title ?? '');
  const [summary, setSummary] = useState(existingReport?.summary ?? '');
  const [milestones, setMilestones] = useState(existingReport?.milestones ?? []);
  const [newMilestone, setNewMilestone] = useState({ title: '', description: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [lastSaved, setLastSaved] = useState(existingReport?.updatedAt ?? null);
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const { showToast } = useToast();

  // Auto-save draft every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      if (title || content) {
        saveDraft();
      }
    }, 30000);

    return () => clearInterval(timer);
  }, [title, content, summary, milestones]);

  async function saveDraft() {
    if (!title && !content) return;

    setIsSaving(true);
    try {
      if (existingReport?.id) {
        // Update existing draft
        await api.put(`/campaigns/${campaignId}/impact-report`, {
          title,
          content,
          summary,
          milestones,
        });
      } else {
        // Create new draft
        const response = await api.post(`/campaigns/${campaignId}/impact-report`, {
          title,
          content,
          summary,
          milestones,
        });
        // Update local state with new report ID
        if (!existingReport) {
          existingReport = { id: response.id };
        }
      }
      setLastSaved(new Date());
      showToast('Draft saved', 'success');
    } catch (error) {
      console.error('Failed to save draft:', error);
      showToast('Failed to save draft', 'error');
    } finally {
      setIsSaving(false);
    }
  }

  const handleAddMilestone = () => {
    if (newMilestone.title.trim()) {
      setMilestones([
        ...milestones,
        {
          title: newMilestone.title,
          description: newMilestone.description,
          achievedAt: new Date().toISOString(),
        },
      ]);
      setNewMilestone({ title: '', description: '' });
    }
  };

  const handleRemoveMilestone = (index) => {
    setMilestones(milestones.filter((_, i) => i !== index));
  };

  async function handlePublish() {
    if (!title || !content) {
      showToast('Title and content are required', 'error');
      return;
    }

    // Save draft first
    await saveDraft();

    setIsPublishing(true);
    try {
      await api.post(`/campaigns/${campaignId}/impact-report/publish`);
      showToast('Impact report published successfully!', 'success');
      setShowPublishConfirm(false);
      if (onPublished) {
        onPublished();
      }
    } catch (error) {
      console.error('Failed to publish report:', error);
      showToast('Failed to publish report', 'error');
    } finally {
      setIsPublishing(false);
    }
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

  const htmlContent = markdownToHtml(content);

  return (
    <div style={{ marginTop: '2rem' }}>
      <h2>Create Impact Report</h2>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--color-border)' }}>
        <button
          type="button"
          onClick={() => setTab('write')}
          style={{
            background: 'none',
            border: 'none',
            padding: '0.75rem 1rem',
            fontSize: '0.95rem',
            fontWeight: tab === 'write' ? 'bold' : 'normal',
            color: tab === 'write' ? 'var(--color-accent)' : 'var(--color-text-hint)',
            cursor: 'pointer',
            borderBottom: tab === 'write' ? '2px solid var(--color-accent)' : 'transparent',
          }}
        >
          ✏️ Write
        </button>
        <button
          type="button"
          onClick={() => setTab('preview')}
          style={{
            background: 'none',
            border: 'none',
            padding: '0.75rem 1rem',
            fontSize: '0.95rem',
            fontWeight: tab === 'preview' ? 'bold' : 'normal',
            color: tab === 'preview' ? 'var(--color-accent)' : 'var(--color-text-hint)',
            cursor: 'pointer',
            borderBottom: tab === 'preview' ? '2px solid var(--color-accent)' : 'transparent',
          }}
        >
          👁️ Preview
        </button>
      </div>

      {/* Write Tab */}
      {tab === 'write' && (
        <div style={{ marginTop: '1.5rem' }}>
          <div style={{ marginBottom: '1.5rem' }}>
            <label
              htmlFor="report-title"
              style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}
            >
              Report Title
            </label>
            <input
              id="report-title"
              type="text"
              placeholder="e.g., Campaign Impact Summary 2026"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength="255"
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '1px solid var(--color-border)',
                borderRadius: '0.5rem',
                fontSize: '1rem',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label
              htmlFor="report-summary"
              style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}
            >
              Summary (Optional)
            </label>
            <textarea
              id="report-summary"
              placeholder="Short summary for notifications (max 500 chars)"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength="500"
              rows="2"
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '1px solid var(--color-border)',
                borderRadius: '0.5rem',
                fontSize: '1rem',
                fontFamily: 'inherit',
              }}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label
              htmlFor="report-content"
              style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}
            >
              Report Content
            </label>
            <SimpleMDEEditor
              value={content}
              onChange={(val) => setContent(val)}
              options={{
                spellChecker: false,
                toolbar: [
                  'bold',
                  'italic',
                  'heading',
                  '|',
                  'quote',
                  'unordered-list',
                  'ordered-list',
                  '|',
                  'link',
                  '|',
                  'preview',
                  'side-by-side',
                  'fullscreen',
                  '|',
                  'guide',
                ],
              }}
            />
          </div>

          {/* Milestones Section */}
          <div
            style={{
              marginBottom: '1.5rem',
              padding: '1rem',
              backgroundColor: 'var(--color-bg-alt)',
              borderRadius: '0.5rem',
            }}
          >
            <h3>Milestones Achieved</h3>
            <p style={{ color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
              Track key achievements and milestones reached during the campaign.
            </p>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: '1rem',
                marginBottom: '1rem',
              }}
            >
              <input
                type="text"
                placeholder="Milestone title"
                value={newMilestone.title}
                onChange={(e) => setNewMilestone({ ...newMilestone, title: e.target.value })}
                style={{
                  padding: '0.75rem',
                  border: '1px solid var(--color-border)',
                  borderRadius: '0.5rem',
                }}
              />
              <textarea
                placeholder="Description"
                value={newMilestone.description}
                onChange={(e) => setNewMilestone({ ...newMilestone, description: e.target.value })}
                rows="2"
                style={{
                  padding: '0.75rem',
                  border: '1px solid var(--color-border)',
                  borderRadius: '0.5rem',
                  fontFamily: 'inherit',
                }}
              />
              <button
                type="button"
                onClick={handleAddMilestone}
                style={{
                  padding: '0.75rem',
                  backgroundColor: 'var(--color-accent)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '0.5rem',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                }}
              >
                Add Milestone
              </button>
            </div>

            {milestones.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {milestones.map((m, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '0.75rem',
                      backgroundColor: 'white',
                      border: '1px solid var(--color-border)',
                      borderRadius: '0.5rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'start',
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 'bold' }}>{m.title}</div>
                      <div style={{ fontSize: '0.9rem', color: 'var(--color-text-hint)' }}>
                        {m.description}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveMilestone(idx)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-error)',
                        cursor: 'pointer',
                        fontSize: '1.1rem',
                        padding: '0.5rem',
                      }}
                      title="Remove milestone"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Save & Publish Buttons */}
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '2rem' }}>
            <button
              type="button"
              onClick={saveDraft}
              disabled={isSaving}
              style={{
                padding: '0.75rem 1.5rem',
                backgroundColor: 'var(--color-border)',
                color: 'var(--color-text)',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: isSaving ? 'not-allowed' : 'pointer',
                opacity: isSaving ? 0.6 : 1,
              }}
            >
              {isSaving ? 'Saving...' : 'Save Draft'}
            </button>

            <button
              type="button"
              onClick={() => setShowPublishConfirm(true)}
              disabled={isPublishing || !title || !content}
              style={{
                padding: '0.75rem 1.5rem',
                backgroundColor: 'var(--color-accent)',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                opacity: isPublishing || !title || !content ? 0.6 : 1,
                fontWeight: 'bold',
              }}
            >
              {isPublishing ? 'Publishing...' : '🚀 Publish & Notify Contributors'}
            </button>

            {lastSaved && (
              <span style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
                Last saved: {new Date(lastSaved).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Preview Tab */}
      {tab === 'preview' && (
        <div style={{ marginTop: '1.5rem' }}>
          <div style={{ marginBottom: '2rem' }}>
            <h2>{title || '(No title)'}</h2>
            {summary && (
              <p
                style={{
                  fontSize: '0.95rem',
                  color: 'var(--color-text-hint)',
                  marginBottom: '1rem',
                }}
              >
                <em>{summary}</em>
              </p>
            )}
            <div
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(htmlContent),
              }}
              style={{
                lineHeight: 1.6,
                color: 'var(--color-text)',
                marginBottom: '2rem',
              }}
            />
          </div>

          {milestones.length > 0 && (
            <div
              style={{
                padding: '1.5rem',
                backgroundColor: 'var(--color-bg-alt)',
                borderRadius: '0.5rem',
                marginBottom: '2rem',
              }}
            >
              <h3>Milestones Achieved 🎯</h3>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {milestones.map((m, idx) => (
                  <li
                    key={idx}
                    style={{
                      padding: '0.75rem 0',
                      borderBottom:
                        idx < milestones.length - 1 ? '1px solid var(--color-border)' : 'none',
                    }}
                  >
                    <strong>{m.title}</strong>
                    <p
                      style={{
                        margin: '0.25rem 0 0 0',
                        color: 'var(--color-text-hint)',
                        fontSize: '0.9rem',
                      }}
                    >
                      {m.description}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ display: 'flex', gap: '1rem' }}>
            <button
              type="button"
              onClick={() => setTab('write')}
              style={{
                padding: '0.75rem 1.5rem',
                backgroundColor: 'var(--color-border)',
                color: 'var(--color-text)',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
              }}
            >
              ← Back to Edit
            </button>

            <button
              type="button"
              onClick={() => setShowPublishConfirm(true)}
              disabled={isPublishing || !title || !content}
              style={{
                padding: '0.75rem 1.5rem',
                backgroundColor: 'var(--color-accent)',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                opacity: isPublishing || !title || !content ? 0.6 : 1,
                fontWeight: 'bold',
              }}
            >
              {isPublishing ? 'Publishing...' : '🚀 Publish & Notify Contributors'}
            </button>
          </div>
        </div>
      )}

      {/* Publish Confirmation Modal */}
      {showPublishConfirm && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: 'white',
              padding: '2rem',
              borderRadius: '0.75rem',
              maxWidth: '500px',
              boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
            }}
          >
            <h3>Publish Impact Report?</h3>
            <p>
              Once published, all contributors to this campaign will be notified about your impact
              report. You can still update the draft before publishing.
            </p>

            <p style={{ fontSize: '0.9rem', color: 'var(--color-text-hint)' }}>
              <strong>Title:</strong> {title}
            </p>

            <div
              style={{
                display: 'flex',
                gap: '1rem',
                marginTop: '1.5rem',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                onClick={() => setShowPublishConfirm(false)}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: 'var(--color-border)',
                  color: 'var(--color-text)',
                  border: 'none',
                  borderRadius: '0.5rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handlePublish}
                disabled={isPublishing}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: 'var(--color-accent)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '0.5rem',
                  cursor: isPublishing ? 'not-allowed' : 'pointer',
                  opacity: isPublishing ? 0.6 : 1,
                  fontWeight: 'bold',
                }}
              >
                {isPublishing ? 'Publishing...' : '🚀 Publish & Notify'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ImpactReportEditor;
