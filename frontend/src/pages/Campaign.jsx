import React, { useEffect, useState } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import ContributeModal from '../components/ContributeModal';
import DisputeModal from '../components/DisputeModal';
import MilestoneTracker from '../components/MilestoneTracker';
import WithdrawalsSection from '../components/WithdrawalsSection';
import CampaignDetailSkeleton from '../components/skeletons/CampaignDetailSkeleton';
import ContributionListSkeleton from '../components/skeletons/ContributionListSkeleton';
import VerificationBadge from '../components/VerificationBadge';

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
    .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, '<br />');
}

export default function Campaign() {
  const { id } = useParams();
  const location = useLocation();
  const { user, token } = useAuth();
  const [campaign, setCampaign] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [contributions, setContributions] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);
  const [contributed, setContributed] = useState(false);
  const [showCreatedBanner, setShowCreatedBanner] = useState(!!location.state?.created);
  const [coverUploadError, setCoverUploadError] = useState(location.state?.coverUploadError || '');
  const [updates, setUpdates] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [updateForm, setUpdateForm] = useState({ title: '', body: '' });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatesError, setUpdatesError] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [members, setMembers] = useState([]);
  const [isOwner, setIsOwner] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'viewer' });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [showEmbedSection, setShowEmbedSection] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);

  useEffect(() => {
    setLoadError('');
    api
      .getCampaign(id, token)
      .then((data) => {
        setCampaign(data);
        if (data.user_role === 'owner') {
          setIsOwner(true);
          api.getCampaignMembers(id, token).then(setMembers).catch(() => {});
        } else {
          setIsOwner(false);
        }
      })
      .catch((err) => setLoadError(err.message || 'Could not load campaign.'));
    api.getCampaignBackers(id).then(setContributions).catch(() => setContributions([]));
    api.getMilestones(id).then(setMilestones).catch(() => setMilestones([]));
    api.getCampaignUpdates(id, { limit: 20 }).then(setUpdates).catch(() => setUpdates([]));
  }, [id, token, contributed]);

  useEffect(() => {
    if (!window.EventSource) return;

    const es = new EventSource(`/api/campaigns/${id}/stream`);

    es.onopen = () => setIsLive(true);

    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'contribution') {
        setCampaign((prev) =>
          prev ? { ...prev, raised_amount: msg.raised_amount } : prev
        );
        setContributions((prev) => {
          const current = prev || [];
          const exists = current.some((c) => c.tx_hash === msg.contribution.tx_hash);
          return exists ? current : [msg.contribution, ...current];
        });
      }
    };

    es.onerror = () => {
      setIsLive(false);
      es.close();
    };

    return () => {
      es.close();
      setIsLive(false);
    };
  }, [id]);

  useEffect(() => {
    if (location.state?.created) {
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  async function handleInviteSubmit(e) {
    e.preventDefault();
    if (!inviteForm.email) {
      setInviteError('Email is required');
      return;
    }
    setInviteBusy(true);
    setInviteError('');
    setInviteSuccess(false);
    try {
      const newMember = await api.inviteCampaignMember(id, inviteForm, token);
      setMembers((prev) => [...prev, newMember]);
      setInviteForm({ email: '', role: 'viewer' });
      setInviteSuccess(true);
    } catch (err) {
      setInviteError(err.message || 'Failed to invite member');
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRoleChange(userId, newRole) {
    try {
      const updated = await api.updateCampaignMemberRole(id, userId, { role: newRole }, token);
      setMembers((prev) =>
        prev.map((m) => (m.user_id === userId ? { ...m, role: updated.role } : m))
      );
    } catch (err) {
      alert(err.message || 'Failed to update role');
    }
  }

  async function handleRemoveMember(userId) {
    if (!confirm('Are you sure you want to remove this member?')) return;
    try {
      await api.removeCampaignMember(id, userId, token);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      alert(err.message || 'Failed to remove member');
    }
  }
  useEffect(() => {
    if (!campaign) return;
    document.title = `${campaign.title} | CrowdPay`;

    // Basic meta tag updates (SPA approach)
    const updateMeta = (name, content, property = false) => {
      let el = document.querySelector(property ? `meta[property="${name}"]` : `meta[name="${name}"]`);
      if (!el) {
        el = document.createElement('meta');
        if (property) el.setAttribute('property', name);
        else el.setAttribute('name', name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    updateMeta('description', campaign.description || '');
    updateMeta('og:title', campaign.title, true);
    updateMeta('og:description', campaign.description || '', true);
    updateMeta('og:url', window.location.href, true);
    if (campaign.cover_image_url) {
      updateMeta('og:image', campaign.cover_image_url, true);
      updateMeta('twitter:image', campaign.cover_image_url);
    }
    updateMeta('twitter:card', 'summary_large_image');
    updateMeta('twitter:title', campaign.title);
    updateMeta('twitter:description', campaign.description || '');
  }, [campaign]);

  if (loadError && !campaign) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '2.5rem' }}>
        <p className="alert alert--error" role="alert">
          {loadError}
        </p>
        <Link to="/" style={{ color: '#7c3aed', fontWeight: 600 }}>
          ← Back home
        </Link>
      </main>
    );
  }

  if (!campaign) {
    return <CampaignDetailSkeleton />;
  }

  const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);
  const canPostUpdate = user?.id && campaign.creator_id === user.id;

  async function submitUpdate(e) {
    e.preventDefault();
    setUpdatesError('');
    setUpdateBusy(true);
    try {
      await api.postCampaignUpdate(
        campaign.id,
        { title: updateForm.title.trim(), body: updateForm.body.trim() },
        token
      );
      setUpdateForm({ title: '', body: '' });
      const list = await api.getCampaignUpdates(id, { limit: 20 });
      setUpdates(list);
    } catch (err) {
      setUpdatesError(err.message || 'Could not publish update');
    } finally {
      setUpdateBusy(false);
    }
  }

  return (
    <main className="container" style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}>
      {showCreatedBanner && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Campaign is live.</strong> Share the link — contributors can fund in XLM or USDC when conversion paths
          are available.
          <button
            type="button"
            onClick={() => setShowCreatedBanner(false)}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: '#065f46',
              textDecoration: 'underline',
              fontWeight: 600,
              padding: 0,
              minHeight: 'auto',
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {coverUploadError && (
        <div className="alert alert--warning" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Cover image upload failed:</strong> {coverUploadError}
        </div>
      )}
      {campaign.status === 'failed' && (
        <div className="alert alert--error" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>This campaign did not reach its goal.</strong> Contributions are closed and refunds can be requested.
        </div>
      )}
      {campaign.creator_kyc_status !== 'verified' && (
        <div className="alert alert--warning" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>Legacy campaign:</strong> this campaign was created before creator identity verification was required.
        </div>
      )}
      {campaign.cover_image_url && (
        <img
          src={campaign.cover_image_url}
          alt={campaign.title}
          style={styles.detailCoverImage}
        />
      )}
      <div style={styles.header}>
        <div style={styles.badgeRow}>
          <span style={styles.asset}>{campaign.asset_type}</span>
          <VerificationBadge status={campaign.creator_kyc_status} />
        </div>
        <h1 style={styles.title}>{campaign.title}</h1>
        {campaign.creator_name && (
          <p style={styles.creator}>
            by {campaign.creator_name}
          </p>
        )}
        <p style={styles.desc}>{campaign.description}</p>
      </div>

      <div style={styles.card}>
        <div style={styles.amounts}>
          <div>
            <div style={styles.big}>{Number(campaign.raised_amount).toLocaleString()} {campaign.asset_type}</div>
            <div style={styles.small}>raised of {Number(campaign.target_amount).toLocaleString()} goal</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={styles.big}>{pct}%</div>
            <div style={styles.small}>funded by <strong>{campaign.contributor_count || 0}</strong> backers</div>
          </div>
        </div>
        <div style={styles.bar}><div style={{ ...styles.fill, width: `${pct}%` }} /></div>

        {(campaign.min_contribution || campaign.max_contribution) && (
          <div style={{ fontSize: '0.85rem', color: '#555', marginBottom: '1rem', background: '#f9fafb', padding: '0.6rem', borderRadius: '6px', textAlign: 'center', border: '1px solid #eee' }}>
            {campaign.min_contribution && `Min: ${Number(campaign.min_contribution).toLocaleString()} ${campaign.asset_type}`}
            {campaign.min_contribution && campaign.max_contribution && ' · '}
            {campaign.max_contribution && `Max: ${Number(campaign.max_contribution).toLocaleString()} ${campaign.asset_type} per backer`}
          </div>
        )}

        {campaign.status === 'active' ? (
          user ? (
            <button type="button" className="btn-primary" style={styles.cta} onClick={() => setShowModal(true)}>
              Contribute
            </button>
          ) : (
            <p style={{ color: '#555', fontSize: '0.9rem', lineHeight: 1.5 }}>
              <Link to="/login" state={{ from: `/campaigns/${id}` }} style={{ color: '#7c3aed', fontWeight: 600 }}>
                Log in
              </Link>{' '}
              or{' '}
              <Link to="/register" style={{ color: '#7c3aed', fontWeight: 600 }}>
                create an account
              </Link>{' '}
              to contribute. You can pay with your CrowdPay custodial wallet or with Freighter when it is installed.
            </p>
          )
        ) : (
          <p style={{ color: '#555', fontSize: '0.9rem', lineHeight: 1.5 }}>
            Contributions are closed while this campaign is <strong>{campaign.status}</strong>.
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.65rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-secondary"
          style={{ flex: 1, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
          onClick={() => {
            const text = encodeURIComponent(`I just backed ${campaign.title} on CrowdPay — ${pct}% funded with ${campaign.contributor_count || 0} backers. Join me: ${window.location.href}`);
            window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank');
          }}
        >
          Share on X
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{ flex: 1, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
          onClick={() => {
            const text = encodeURIComponent(`I just backed ${campaign.title} on CrowdPay — ${pct}% funded with ${campaign.contributor_count || 0} backers. Join me: ${window.location.href}`);
            window.open(`https://wa.me/?text=${text}`, '_blank');
          }}
        >
          WhatsApp
        </button>
        <button
          type="button"
          className="btn-secondary"
          style={{ flex: 1, fontSize: '0.85rem' }}
          onClick={() => {
            navigator.clipboard.writeText(window.location.href);
            alert('Link copied to clipboard!');
          }}
        >
          Copy link
        </button>
      </div>

      <div style={styles.walletInfo}>
        <span style={styles.walletLabel}>Campaign wallet</span>
        <code style={styles.walletKey}>{campaign.wallet_public_key}</code>
      </div>

      {/* Report a problem — visible to contributors who have backed this campaign */}
      {user && contributions?.some((c) => c.sender_public_key) && campaign.creator_id !== user.id && (
        <div style={{ marginBottom: '1.25rem' }}>
          {disputeSubmitted ? (
            <p className="alert alert--success" role="status">
              Your dispute has been submitted. The platform team will review it shortly.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setShowDisputeModal(true)}
              style={{ background: 'none', border: 'none', color: '#dc2626', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
            >
              ⚠ Report a problem with this campaign
            </button>
          )}
        </div>
      )}
      {canPostUpdate && (
        <div style={styles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Embed this campaign</h3>
            <button
              type="button"
              onClick={() => setShowEmbedSection(!showEmbedSection)}
              style={{
                background: 'transparent',
                color: '#7c3aed',
                border: '1px solid #7c3aed',
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
              <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: '1rem', lineHeight: 1.5 }}>
                Add this embed code to your website or blog to display a live funding widget for this campaign.
              </p>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#555', display: 'block', marginBottom: '0.5rem' }}>
                  Embed code
                </label>
                <div style={{ position: 'relative' }}>
                  <pre style={styles.embedCode}>
                    {`<iframe src="${window.location.origin}/embed/campaigns/${campaign.id}" \n        width="480" height="280" frameborder="0">\n</iframe>`}
                  </pre>
                  <button
                    type="button"
                    onClick={() => {
                      const code = `<iframe src="${window.location.origin}/embed/campaigns/${campaign.id}" width="480" height="280" frameborder="0"></iframe>`;
                      navigator.clipboard.writeText(code).then(() => {
                        setEmbedCopied(true);
                        setTimeout(() => setEmbedCopied(false), 2000);
                      });
                    }}
                    style={{
                      position: 'absolute',
                      top: '0.5rem',
                      right: '0.5rem',
                      background: embedCopied ? '#10b981' : '#7c3aed',
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

              <div>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#555', display: 'block', marginBottom: '0.5rem' }}>
                  Preview
                </label>
                <div style={styles.embedPreview}>
                  <iframe
                    src={`/embed/campaigns/${campaign.id}`}
                    width="100%"
                    height="280"
                    frameBorder="0"
                    title="Campaign embed preview"
                    style={{ border: '1px solid #e5e5e5', borderRadius: '6px' }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {token && (
        <WithdrawalsSection
          campaign={campaign}
          milestones={milestones}
          user={user}
          token={token}
          onReleased={() => {
            api.getCampaign(id).then(setCampaign).catch(() => {});
            api.getMilestones(id).then(setMilestones).catch(() => {});
          }}
        />
      )}

      <MilestoneTracker milestones={milestones} assetType={campaign.asset_type} />

      {isOwner && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={styles.sectionTitle}>Team Management</h2>
          <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
            <strong style={{ marginBottom: '0.75rem', display: 'block' }}>Invite Team Member</strong>
            <form onSubmit={handleInviteSubmit} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 250px' }}>
                <label style={{ fontSize: '0.85rem', color: '#666', display: 'block', marginBottom: '0.25rem' }}>Email</label>
                <input
                  type="email"
                  placeholder="member@example.com"
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm((s) => ({ ...s, email: e.target.value }))}
                  required
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ width: '120px' }}>
                <label style={{ fontSize: '0.85rem', color: '#666', display: 'block', marginBottom: '0.25rem' }}>Role</label>
                <select
                  value={inviteForm.role}
                  onChange={(e) => setInviteForm((s) => ({ ...s, role: e.target.value }))}
                  style={{ width: '100%', padding: '0.5rem' }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="manager">Manager</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              <button type="submit" className="btn-primary" disabled={inviteBusy} style={{ height: '38px' }}>
                {inviteBusy ? 'Sending…' : 'Invite'}
              </button>
            </form>
            {inviteError && <p className="alert alert--error" style={{ marginTop: '0.75rem' }}>{inviteError}</p>}
            {inviteSuccess && <p className="alert alert--success" style={{ marginTop: '0.75rem' }}>Invitation sent!</p>}
          </div>

          <div className="campaign-card">
            <strong style={{ marginBottom: '0.75rem', display: 'block' }}>Current Team</strong>
            {members.length === 0 ? (
              <p style={{ color: '#999' }}>No team members yet.</p>
            ) : (
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {members.map((member) => (
                  <div key={member.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', borderBottom: '1px solid #eee', paddingBottom: '0.5rem' }}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{member.email}</span>
                      {member.user_name && <span style={{ color: '#666', fontSize: '0.85rem', marginLeft: '0.5rem' }}>({member.user_name})</span>}
                      <div style={{ fontSize: '0.75rem', color: member.accepted_at ? '#10b981' : '#f59e0b', fontWeight: 600 }}>
                        {member.accepted_at ? 'Accepted' : 'Pending'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <select
                        value={member.role}
                        onChange={(e) => handleRoleChange(member.user_id, e.target.value)}
                        disabled={!member.user_id || String(member.user_id) === String(user?.id)}
                        style={{ padding: '0.25rem', fontSize: '0.85rem' }}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="manager">Manager</option>
                        <option value="owner">Owner</option>
                      </select>
                      <button
                        className="btn-secondary"
                        onClick={() => handleRemoveMember(member.user_id)}
                        disabled={String(member.user_id) === String(user?.id)}
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', color: '#ef4444', borderColor: '#ef4444' }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <h2 style={styles.sectionTitle}>Updates ({updates.length})</h2>
      {canPostUpdate && (
        <form onSubmit={submitUpdate} className="campaign-card" style={{ marginBottom: '1rem' }}>
          <strong style={{ marginBottom: '0.5rem', display: 'block' }}>Post update</strong>
          <input
            placeholder="Update title"
            value={updateForm.title}
            onChange={(e) => setUpdateForm((s) => ({ ...s, title: e.target.value }))}
            required
            style={{ marginBottom: '0.5rem' }}
          />
          <textarea
            placeholder="Write markdown update..."
            value={updateForm.body}
            onChange={(e) => setUpdateForm((s) => ({ ...s, body: e.target.value }))}
            rows={4}
            required
          />
          {updatesError && <p className="alert alert--error" style={{ marginTop: '0.5rem' }}>{updatesError}</p>}
          <button type="submit" className="btn-primary" disabled={updateBusy} style={{ marginTop: '0.5rem' }}>
            {updateBusy ? 'Posting...' : 'Post update'}
          </button>
        </form>
      )}
      {updates.length === 0 ? (
        <p style={{ color: '#999', marginBottom: '1rem' }}>No updates posted yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.25rem' }}>
          {updates.map((update) => (
            <article key={update.id} className="campaign-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <strong>{update.title}</strong>
                <span style={{ color: '#666', fontSize: '0.85rem' }}>
                  {update.author_name} • {new Date(update.created_at).toLocaleString()}
                </span>
              </div>
              <div
                style={{ marginTop: '0.5rem', color: '#333', lineHeight: 1.5 }}
                dangerouslySetInnerHTML={{ __html: markdownToHtml(update.body) }}
              />
            </article>
          ))}
        </div>
      )}

      <h2 style={styles.sectionTitle}>
        Backer Wall {contributions !== null ? `(${contributions.length})` : ''}
        {isLive && (
          <span style={styles.liveIndicator} title="Live updates active">
            <span style={styles.liveDot} />
            Live
          </span>
        )}
      </h2>
      {contributions === null ? (
        <ContributionListSkeleton />
      ) : contributions.length === 0 ? (
        <div style={styles.emptyBackers}>
          <p>Be the first to back this!</p>
          <p style={{ fontSize: '0.9rem', color: '#888', marginTop: '0.25rem' }}>Every contribution counts towards making this goal a reality.</p>
        </div>
      ) : (
        <div style={styles.list}>
          {contributions.map((c) => (
            <div key={c.id} style={styles.row}>
              <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={styles.avatar}>
                  {(c.display_name || 'A')[0].toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={styles.sender}>
                    {c.display_name || 'Anonymous'}
                  </div>
                  <div style={styles.convHint}>
                    {c.sender_public_key.slice(0, 4)}…{c.sender_public_key.slice(-4)} • {new Date(c.created_at).toLocaleDateString()}
                  </div>
                  {c.refund_status && (
                    <div style={styles.refundTag}>
                      {c.refund_status === 'pending' && 'Refund pending'}
                      {c.refund_status === 'submitted' && 'Refunded'}
                      {c.refund_status === 'indexed' && 'Refunded'}
                      {c.refund_status === 'failed' && 'Refund failed'}
                      {c.refund_status === 'denied' && 'Refund denied'}
                    </div>
                  )}
                </div>
              </div>
              {c.amount != null && (
                <span style={styles.amount}>
                  {Number(c.amount).toLocaleString()} {c.asset}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <ContributeModal
          campaign={campaign}
          onClose={() => setShowModal(false)}
          onSuccess={() => setContributed((v) => !v)}
        />
      )}
      {showDisputeModal && (
        <DisputeModal
          campaign={campaign}
          onClose={() => setShowDisputeModal(false)}
          onSubmitted={() => setDisputeSubmitted(true)}
        />
      )}
    </main>
  );
}

const styles = {
  header: { marginBottom: '1.5rem' },
  badgeRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  asset: { background: '#ede9fe', color: '#7c3aed', fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: '99px' },
  title: { fontSize: '1.8rem', fontWeight: 800, margin: '0.5rem 0', color: '#111' },
  creator: { color: '#666', fontSize: '0.9rem', marginBottom: '0.5rem' },
  desc: { color: '#555', fontSize: '1rem', lineHeight: 1.6 },
  card: { background: '#fff', border: '1px solid #e5e5e5', borderRadius: '10px', padding: '1.5rem', marginBottom: '1rem' },
  amounts: { display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' },
  big: { fontSize: '1.5rem', fontWeight: 800, color: '#111' },
  small: { fontSize: '0.85rem', color: '#888' },
  bar: { background: '#f0f0f0', borderRadius: '99px', height: '8px', marginBottom: '1.25rem', overflow: 'hidden' },
  fill: { background: '#7c3aed', height: '100%', borderRadius: '99px' },
  cta: { width: '100%', padding: '0.85rem', fontSize: '1rem' },
  walletInfo: { background: '#f8f8f8', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  walletLabel: { fontSize: '0.75rem', fontWeight: 600, color: '#888', textTransform: 'uppercase' },
  walletKey: { fontSize: '0.8rem', color: '#555', wordBreak: 'break-all' },
  detailCoverImage: { width: '100%', borderRadius: '14px', marginBottom: '1.5rem', objectFit: 'cover', maxHeight: '360px' },
  sectionTitle: { fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.75rem' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  row: { display: 'flex', justifyContent: 'space-between', background: '#fff', border: '1px solid #eee', borderRadius: '6px', padding: '0.6rem 0.85rem' },
  sender: { fontSize: '0.85rem', color: '#555', fontFamily: 'monospace' },
  amount: { fontSize: '0.85rem', fontWeight: 600, flexShrink: 0 },
  convHint: { fontSize: '0.72rem', color: '#888', marginTop: '0.15rem' },
  refundTag: { marginTop: '0.45rem', fontSize: '0.75rem', color: '#7c3aed', fontWeight: 700 },
  liveIndicator: { display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '0.5rem', fontSize: '0.72rem', fontWeight: 600, color: '#16a34a', verticalAlign: 'middle' },
  liveDot: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: '#16a34a', animation: 'pulse 1.5s ease-in-out infinite' },
  embedCode: {
    background: '#f8f8f8',
    border: '1px solid #e5e5e5',
    borderRadius: '6px',
    padding: '0.75rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    color: '#333',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    paddingRight: '5rem',
  },
  embedPreview: {
    background: '#fafafa',
    border: '1px solid #e5e5e5',
    borderRadius: '6px',
    padding: '0.75rem',
  },
  emptyBackers: { padding: '2.5rem 1rem', textAlign: 'center', background: '#fcfaff', border: '2px dashed #ede9fe', borderRadius: '12px', color: '#7c3aed', fontWeight: 700 },
  avatar: { width: '36px', height: '36px', borderRadius: '50%', background: '#ede9fe', color: '#7c3aed', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem', fontWeight: 800, flexShrink: 0 },
};
