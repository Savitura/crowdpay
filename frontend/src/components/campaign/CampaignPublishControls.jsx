import React, { useState } from 'react';
import { api } from '../../services/api';

export default function CampaignPublishControls({ campaign, isOwner, navigate }) {
  const [cloning, setCloning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [error, setError] = useState('');

  if (!isOwner || !campaign) return null;

  async function clone() {
    setCloning(true);
    setError('');
    try {
      const newCampaign = await api.cloneCampaign(campaign.id);
      navigate(`/campaigns/${newCampaign.id}`);
    } catch (err) {
      setError(err.message || 'Could not clone campaign');
      setCloning(false);
    }
  }

  async function publishNow() {
    setPublishing(true);
    setError('');
    try {
      await api.publishCampaign(campaign.id);
      window.location.reload();
    } catch (err) {
      setError(err.message || 'Could not publish campaign');
      setPublishing(false);
    }
  }

  async function schedulePublish(e) {
    e.preventDefault();
    setScheduling(true);
    setError('');
    try {
      await api.scheduleCampaignPublish(campaign.id, { scheduled_publish_at: scheduledAt || null });
      window.location.reload();
    } catch (err) {
      setError(err.message || 'Could not schedule publishing');
      setScheduling(false);
    }
  }

  return (
    <div data-no-print style={{ marginBottom: '1.25rem' }}>
      {campaign.status === 'draft' && (
        <div
          className="campaign-card"
          style={{
            minHeight: 'auto',
            padding: '0.85rem',
            marginBottom: '0.75rem',
            display: 'grid',
            gap: '0.6rem',
          }}
        >
          <strong style={{ fontSize: '0.9rem' }}>This campaign is a draft</strong>
          <p style={{ fontSize: '0.82rem', color: 'var(--color-text-hint)', margin: 0 }}>
            No wallet or on-chain contracts exist yet. Publish now, or schedule an automatic publish
            time.
          </p>
          {campaign.scheduled_publish_at && (
            <p style={{ fontSize: '0.82rem', margin: 0 }}>
              Scheduled to auto-publish at{' '}
              {new Date(campaign.scheduled_publish_at).toLocaleString()}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={publishNow}
              disabled={publishing}
            >
              {publishing ? 'Publishing...' : 'Publish now'}
            </button>
          </div>
          <form
            onSubmit={schedulePublish}
            style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
          >
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              style={{ fontSize: '0.85rem' }}
            />
            <button
              type="submit"
              className="btn-secondary"
              disabled={scheduling}
              style={{ fontSize: '0.85rem' }}
            >
              {scheduling ? 'Saving...' : 'Schedule publish'}
            </button>
          </form>
          {error && (
            <p className="alert alert--error" style={{ fontSize: '0.8rem', margin: 0 }}>
              {error}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className="btn-secondary"
        style={{ fontSize: '0.85rem' }}
        onClick={clone}
        disabled={cloning}
      >
        {cloning ? 'Cloning...' : 'Clone campaign'}
      </button>
      {campaign.status !== 'draft' && error && (
        <p className="alert alert--error" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}
