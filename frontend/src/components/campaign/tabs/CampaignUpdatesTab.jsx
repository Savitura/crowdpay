import React from 'react';
import DOMPurify from 'dompurify';
import RelativeTime from '../../RelativeTime';

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

export default function CampaignUpdatesTab({
  updates = [],
  canPostUpdate = false,
  submitUpdate,
  editingUpdateId = null,
  setEditingUpdateId,
  updateForm = { title: '', body: '' },
  setUpdateForm,
  updateBusy = false,
  updatesError = '',
  setUpdatesError,
  deleteUpdate,
  startEditUpdate,
  maxBodyLength = 5000,
  warnThreshold = 4500,
}) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h2 style={styles.sectionTitle}>Updates ({updates.length})</h2>

      {canPostUpdate && (
        <form
          onSubmit={submitUpdate}
          className="campaign-card"
          style={{ marginBottom: '1rem' }}
          data-no-print
        >
          <strong style={{ marginBottom: '0.5rem', display: 'block' }}>
            {editingUpdateId ? 'Edit update' : 'Post update'}
          </strong>
          <label htmlFor="update-title" className="sr-only">
            Update title
          </label>
          <input
            id="update-title"
            placeholder="Update title"
            value={updateForm.title}
            onChange={(e) => setUpdateForm((s) => ({ ...s, title: e.target.value }))}
            required
            style={{ marginBottom: '0.5rem', width: '100%' }}
          />
          <label htmlFor="update-body" className="sr-only">
            Update body
          </label>
          <textarea
            id="update-body"
            placeholder="Write markdown update..."
            value={updateForm.body}
            onChange={(e) => setUpdateForm((s) => ({ ...s, body: e.target.value }))}
            rows={4}
            required
            style={{ width: '100%' }}
          />
          <div
            aria-live="polite"
            style={{
              fontSize: '0.8rem',
              marginTop: '0.25rem',
              textAlign: 'right',
              color:
                updateForm.body.length > maxBodyLength
                  ? 'var(--color-status-error)'
                  : updateForm.body.length >= warnThreshold
                    ? 'var(--color-status-warning, var(--color-status-error))'
                    : 'var(--color-text-hint)',
            }}
          >
            {maxBodyLength - updateForm.body.length} characters left
          </div>
          {updatesError && (
            <div
              style={{
                color: 'var(--color-status-error)',
                fontSize: '0.85rem',
                marginTop: '0.5rem',
              }}
            >
              {updatesError}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="submit" className="btn-primary" disabled={updateBusy}>
              {updateBusy ? 'Saving...' : editingUpdateId ? 'Save changes' : 'Post'}
            </button>
            {editingUpdateId && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  if (setEditingUpdateId) setEditingUpdateId(null);
                  if (setUpdateForm) setUpdateForm({ title: '', body: '' });
                  if (setUpdatesError) setUpdatesError('');
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {updates.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
          No updates posted yet.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {updates.map((update) => (
            <article key={update.id} className="campaign-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                }}
              >
                <strong>{update.title}</strong>
                <span
                  style={{
                    color: 'var(--color-text-hint)',
                    fontSize: '0.85rem',
                  }}
                >
                  {update.author_name} - <RelativeTime date={update.created_at} />
                </span>
              </div>
              <div
                style={{
                  marginTop: '0.5rem',
                  color: 'var(--color-text-primary)',
                  lineHeight: 1.5,
                }}
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(markdownToHtml(update.body)),
                }}
              />
              {canPostUpdate && (
                <div
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    marginTop: '0.75rem',
                    justifyContent: 'flex-end',
                  }}
                >
                  {startEditUpdate && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => startEditUpdate(update)}
                      style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}
                    >
                      Edit
                    </button>
                  )}
                  {deleteUpdate && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => deleteUpdate(update.id)}
                      style={{
                        padding: '0.2rem 0.6rem',
                        fontSize: '0.75rem',
                        color: 'var(--color-status-error)',
                        borderColor: 'var(--color-status-error)',
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  sectionTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
};
