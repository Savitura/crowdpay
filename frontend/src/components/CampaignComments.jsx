import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function CommentComposer({ placeholder, submitLabel, onSubmit, onCancel, autoFocus }) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!value.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await onSubmit(value.trim());
      setValue('');
      onCancel?.();
    } catch (err) {
      setError(err.message || 'Could not post comment');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: '0.65rem', marginBottom: '0.65rem' }}>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={3}
        style={{
          width: '100%',
          borderRadius: '8px',
          border: '1px solid var(--color-border-lighter, #d1d5db)',
          padding: '0.6rem 0.75rem',
          fontFamily: 'inherit',
          fontSize: '0.88rem',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
      {error && (
        <p className="alert alert--error" style={{ marginTop: '0.35rem', fontSize: '0.8rem' }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
        <button type="submit" className="btn-primary" disabled={submitting || !value.trim()}>
          {submitting ? 'Posting…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function CommentItem({
  comment,
  replies,
  campaignId,
  isModerator,
  currentUserId,
  campaign,
  onChanged,
}) {
  const toast = useToast();
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState('');
  const [upvotesCount, setUpvotesCount] = useState(comment.upvotes_count || 0);
  const [userUpvoted, setUserUpvoted] = useState(!!comment.user_upvoted);

  useEffect(() => {
    setUpvotesCount(comment.upvotes_count || 0);
    setUserUpvoted(!!comment.user_upvoted);
  }, [comment.upvotes_count, comment.user_upvoted]);

  const isAuthor = currentUserId && String(comment.author_id) === String(currentUserId);
  const isCreator =
    comment.is_creator_reply ||
    (campaign?.creator_id && String(comment.author_id) === String(campaign?.creator_id));
  const canDelete = isAuthor || isModerator;

  async function toggleUpvote() {
    if (!currentUserId) {
      toast?.('Please log in to upvote questions', 'error');
      return;
    }
    try {
      const res = await api.upvoteCampaignComment(campaignId, comment.id);
      setUserUpvoted(res.upvoted);
      setUpvotesCount(res.upvotes_count);
    } catch (err) {
      setError(err.message || 'Could not upvote comment');
    }
  }

  async function reply(body) {
    await api.postCampaignComment(campaignId, { body, parent_id: comment.id });
    onChanged();
  }

  async function remove() {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await api.deleteCampaignComment(campaignId, comment.id);
      onChanged();
    } catch (err) {
      setError(err.message || 'Could not delete comment');
    }
  }

  async function flag() {
    try {
      await api.flagCampaignComment(campaignId, comment.id, {});
      toast?.('Comment reported for moderation review', 'success');
    } catch (err) {
      setError(err.message || 'Could not flag comment');
    }
  }

  async function hide() {
    try {
      await api.hideCampaignComment(campaignId, comment.id, {});
      onChanged();
    } catch (err) {
      setError(err.message || 'Could not hide comment');
    }
  }

  async function unhide() {
    try {
      await api.unhideCampaignComment(campaignId, comment.id);
      onChanged();
    } catch (err) {
      setError(err.message || 'Could not unhide comment');
    }
  }

  return (
    <div
      data-testid={`comment-${comment.id}`}
      style={{
        padding: '0.75rem 0',
        borderTop: '1px solid var(--color-border-lighter, #e5e7eb)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: '0.88rem' }}>{comment.author_name || 'Anonymous'}</strong>
          {isCreator && (
            <span
              className="creator-badge"
              style={{
                backgroundColor: 'var(--color-accent, #2563eb)',
                color: '#ffffff',
                fontSize: '0.7rem',
                fontWeight: 700,
                padding: '0.15rem 0.5rem',
                borderRadius: '999px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              Creator
            </span>
          )}
          {comment.is_supporter && !isCreator && (
            <span
              className="supporter-badge"
              data-testid="supporter-badge"
              title="This backer contributed to the campaign"
              style={{
                backgroundColor: 'var(--color-accent-soft, rgba(37, 99, 235, 0.12))',
                color: 'var(--color-accent, #2563eb)',
                fontSize: '0.7rem',
                fontWeight: 700,
                padding: '0.15rem 0.5rem',
                borderRadius: '999px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              Backer
            </span>
          )}
        </div>
        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-hint, #6b7280)' }}>
          {timeAgo(comment.created_at)}
        </span>
      </div>

      {comment.hidden ? (
        <p
          style={{
            fontSize: '0.82rem',
            fontStyle: 'italic',
            color: 'var(--color-text-hint)',
            margin: '0.4rem 0',
          }}
        >
          Hidden by moderator{comment.hidden_reason ? `: ${comment.hidden_reason}` : ''}
          {isModerator && ' (visible to creator/admin only)'}
        </p>
      ) : (
        <p
          style={{
            fontSize: '0.9rem',
            margin: '0.4rem 0',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.5,
          }}
        >
          {comment.body}
        </p>
      )}

      {error && (
        <p className="alert alert--error" style={{ fontSize: '0.78rem', marginBottom: '0.3rem' }}>
          {error}
        </p>
      )}

      <div
        style={{
          display: 'flex',
          gap: '0.65rem',
          alignItems: 'center',
          fontSize: '0.78rem',
          marginTop: '0.3rem',
        }}
      >
        <button
          type="button"
          onClick={toggleUpvote}
          title={userUpvoted ? 'Remove upvote' : 'Upvote question'}
          style={{
            background: userUpvoted ? 'var(--color-accent-bg, #eff6ff)' : 'transparent',
            color: userUpvoted
              ? 'var(--color-accent, #2563eb)'
              : 'var(--color-text-secondary, #4b5563)',
            border: userUpvoted
              ? '1px solid var(--color-accent-border, #bfdbfe)'
              : '1px solid var(--color-border-light, #d1d5db)',
            borderRadius: '4px',
            padding: '0.15rem 0.45rem',
            cursor: 'pointer',
            fontSize: '0.78rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
            fontWeight: userUpvoted ? 600 : 400,
          }}
          aria-label="Upvote comment"
        >
          ▲ {upvotesCount}
        </button>

        {currentUserId && (
          <button
            type="button"
            onClick={() => setReplying((r) => !r)}
            style={{
              color: 'var(--color-accent, #2563eb)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Reply
          </button>
        )}
        {currentUserId && !isAuthor && (
          <button
            type="button"
            onClick={flag}
            title="Report inappropriate comment"
            style={{
              color: 'var(--color-text-hint, #6b7280)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Report / Flag
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={remove}
            style={{
              color: 'var(--color-error-text, #dc2626)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Delete
          </button>
        )}
        {isModerator &&
          (comment.hidden ? (
            <button
              type="button"
              onClick={unhide}
              style={{
                color: 'var(--color-text-hint)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Unhide
            </button>
          ) : (
            <button
              type="button"
              onClick={hide}
              style={{
                color: 'var(--color-text-hint)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Hide
            </button>
          ))}
      </div>

      {replying && (
        <CommentComposer
          placeholder="Write a reply…"
          submitLabel="Reply"
          autoFocus
          onSubmit={reply}
          onCancel={() => setReplying(false)}
        />
      )}

      {replies.length > 0 && (
        <div style={{ marginLeft: '1.25rem', marginTop: '0.5rem' }}>
          {replies.map((reply) => (
            <CommentItem
              key={reply.id}
              comment={reply}
              replies={[]}
              campaignId={campaignId}
              isModerator={isModerator}
              currentUserId={currentUserId}
              campaign={campaign}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CampaignComments({ campaignId, campaign }) {
  const { user } = useAuth();
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModeration, setShowModeration] = useState(false);
  const [flagged, setFlagged] = useState([]);

  const currentUserId = user?.id || user?.userId;
  const isModerator =
    !!currentUserId &&
    (String(campaign?.creator_id) === String(currentUserId) || user?.role === 'admin');

  function load() {
    setLoading(true);
    setError('');
    api
      .getCampaignComments(campaignId)
      .then((data) => setComments(Array.isArray(data) ? data : []))
      .catch((err) => setError(err.message || 'Could not load comments'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (campaignId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    if (!showModeration || !campaignId) return;
    api
      .getFlaggedCampaignComments(campaignId)
      .then(setFlagged)
      .catch(() => setFlagged([]));
  }, [showModeration, campaignId]);

  const { topLevel, repliesByParent } = useMemo(() => {
    const top = [];
    const byParent = {};
    for (const comment of comments) {
      if (comment.parent_id) {
        byParent[comment.parent_id] = byParent[comment.parent_id] || [];
        byParent[comment.parent_id].push(comment);
      } else {
        top.push(comment);
      }
    }
    return { topLevel: top, repliesByParent: byParent };
  }, [comments]);

  async function postTopLevel(body) {
    await api.postCampaignComment(campaignId, { body });
    load();
  }

  return (
    <div
      className="campaign-card"
      style={{
        marginTop: '1.5rem',
        marginBottom: '1.5rem',
        padding: '1.25rem',
        borderRadius: '12px',
        border: '1px solid var(--color-border-lighter, #e5e7eb)',
        backgroundColor: 'var(--color-bg-card, #ffffff)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '0.75rem',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
          Campaign Q&A & Comments ({comments.filter((c) => !c.hidden).length})
        </h3>
        {isModerator && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowModeration((v) => !v)}
            style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
          >
            {showModeration ? 'Hide moderation queue' : 'Moderation queue'}
          </button>
        )}
      </div>

      {showModeration && (
        <div
          style={{
            marginTop: '0.6rem',
            marginBottom: '1rem',
            padding: '0.75rem',
            borderRadius: '8px',
            background: 'var(--color-warning-bg, #fffbeb)',
            border: '1px solid var(--color-warning-border, #fde68a)',
          }}
        >
          <strong style={{ fontSize: '0.85rem' }}>Flagged / hidden comments queue</strong>
          {flagged.length === 0 ? (
            <p style={{ fontSize: '0.8rem', margin: '0.3rem 0 0' }}>
              Nothing currently needs review.
            </p>
          ) : (
            flagged.map((c) => (
              <div
                key={c.id}
                style={{
                  fontSize: '0.82rem',
                  marginTop: '0.4rem',
                  padding: '0.4rem 0',
                  borderTop: '1px border-dashed #fcd34d',
                }}
              >
                <strong>{c.author_name}</strong> ({c.flag_count} flag{c.flag_count !== 1 ? 's' : ''}
                {c.hidden ? ', hidden' : ''}): &quot;{c.body}&quot;
              </div>
            ))
          )}
        </div>
      )}

      {currentUserId ? (
        <CommentComposer
          placeholder="Ask a question or share a comment with the creator and backers…"
          submitLabel="Ask question / Post comment"
          onSubmit={postTopLevel}
        />
      ) : (
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: 'var(--color-bg-secondary, #f9fafb)',
            borderRadius: '8px',
            fontSize: '0.88rem',
            color: 'var(--color-text-secondary, #4b5563)',
            marginBottom: '1rem',
          }}
        >
          Have questions for the creator? Log in to ask questions, post comments, or upvote answers.
        </div>
      )}

      {loading && (
        <p style={{ color: 'var(--color-text-hint)', fontSize: '0.85rem' }}>
          Loading Q&A comments…
        </p>
      )}
      {error && (
        <p className="alert alert--error" style={{ fontSize: '0.82rem' }}>
          {error}
        </p>
      )}

      {!loading && topLevel.length === 0 && (
        <p
          style={{
            color: 'var(--color-text-hint)',
            fontSize: '0.88rem',
            fontStyle: 'italic',
            marginTop: '0.5rem',
          }}
        >
          No questions or comments yet. Be the first to ask the creator!
        </p>
      )}

      <div style={{ marginTop: '0.5rem' }}>
        {topLevel.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            replies={repliesByParent[comment.id] || []}
            campaignId={campaignId}
            isModerator={isModerator}
            currentUserId={currentUserId}
            campaign={campaign}
            onChanged={load}
          />
        ))}
      </div>
    </div>
  );
}
