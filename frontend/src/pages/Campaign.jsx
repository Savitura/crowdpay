import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import ContributeModal from '../components/ContributeModal';
import RefundsSection from '../components/RefundsSection';
import { TreasuryTransparencyPanel } from '../components/TreasuryPanel';
import DisputeModal from '../components/DisputeModal';
import EvidenceForm from '../components/EvidenceForm';
import CampaignDetailSkeleton from '../components/skeletons/CampaignDetailSkeleton';
import VerificationBadge from '../components/VerificationBadge';
import CampaignStatusBadge from '../components/CampaignStatusBadge';
import CampaignQRCode from '../components/CampaignQRCode';
import { getNetwork, signTransaction, isConnected } from '@stellar/freighter-api';
import FollowCampaignButton from '../components/FollowCampaignButton';
import PoolManager from '../components/PoolManager';
import LanguageToggle from '../components/LanguageToggle';
import { useExchangeRate } from '../hooks/useExchangeRate';
import { useCampaignData } from '../hooks/useCampaignData';
import {
  useCampaignUpdates,
  UPDATE_BODY_MAX,
  UPDATE_BODY_WARN_THRESHOLD,
} from '../hooks/useCampaignUpdates';

import CampaignAboutTab from '../components/campaign/tabs/CampaignAboutTab';
import CampaignRewardsTab from '../components/campaign/tabs/CampaignRewardsTab';
import CampaignUpdatesTab from '../components/campaign/tabs/CampaignUpdatesTab';
import CampaignCommentsTab from '../components/campaign/tabs/CampaignCommentsTab';
import CampaignTeamTab from '../components/campaign/tabs/CampaignTeamTab';
import CampaignAnalyticsTab from '../components/campaign/tabs/CampaignAnalyticsTab';
import CampaignContributionsTab from '../components/campaign/tabs/CampaignContributionsTab';
import CampaignEditModal from '../components/campaign/CampaignEditModal';
import CampaignShareBar from '../components/campaign/CampaignShareBar';
import CampaignEmbedSection from '../components/campaign/CampaignEmbedSection';
import CampaignPublishControls from '../components/campaign/CampaignPublishControls';
import {
  CampaignRequirementsNotice,
  ContributorEligibilityBadge,
} from '../components/campaign/CampaignEligibilityNotices';

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

function progressColor(pct, status) {
  if (status === 'funded' || pct >= 100) return 'var(--color-teal)';
  if (status === 'closed' || status === 'withdrawn' || status === 'refunded' || status === 'failed')
    return 'var(--color-text-hint)';
  if (pct >= 75) return 'var(--color-accent-light)';
  return 'var(--color-accent)';
}

function FavoriteToggle({ campaignId }) {
  const [favorited, setFavorited] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      if (favorited) {
        await api.removeFavorite(campaignId);
        setFavorited(false);
      } else {
        await api.addFavorite(campaignId);
        setFavorited(true);
      }
    } catch {
      // no-op - leave state unchanged on failure
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={favorited ? 'Remove from favorites' : 'Add to favorites'}
      style={{
        background: 'none',
        border: '1px solid var(--color-border-lighter)',
        borderRadius: '999px',
        fontSize: '0.85rem',
        padding: '0.2rem 0.6rem',
        cursor: 'pointer',
        color: favorited ? 'var(--color-accent)' : 'var(--color-text-hint)',
      }}
    >
      {favorited ? 'Favorited' : 'Favorite'}
    </button>
  );
}

export default function Campaign() {
  const contributeBtnRef = useRef(null);
  const deleteModalRef = useRef(null);
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, token } = useAuth();
  const toast = useToast();
  const { t, i18n } = useTranslation();
  const currentLocale = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];

  const queryParams = new URLSearchParams(location.search);
  const refParam = queryParams.get('ref') || null;
  const presetAmount = queryParams.get('amount') || '';

  const [contributed, setContributed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [isLive, setIsLive] = useState(false);

  const {
    campaign,
    setCampaign,
    loadError,
    milestones,
    setMilestones,
    stretchGoals,
    tiers,
    nftRewards,
    contributions,
    setContributions,
    totalContributions,
    setTotalContributions,
    activeDispute,
    hasPendingWithdrawal,
    refreshCampaign,
  } = useCampaignData({
    id,
    currentLocale,
    refParam,
    token,
    user,
    contributed,
    isLive,
    showAll,
  });

  const {
    updates,
    updateForm,
    setUpdateForm,
    updateBusy,
    updatesError,
    setUpdatesError,
    editingUpdateId,
    setEditingUpdateId,
    submitUpdate,
    deleteUpdate,
    startEditUpdate,
  } = useCampaignUpdates({ campaignId: id, user });

  const { formatNaira } = useExchangeRate(campaign?.asset_type || 'USDC');
  const nairaRaised = campaign ? formatNaira(campaign.raised_amount) : null;
  const nairaTarget = campaign ? formatNaira(campaign.target_amount) : null;

  const [translation, setTranslation] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [showDisputeModal, setShowDisputeModal] = useState(false);
  const [disputeSubmitted, setDisputeSubmitted] = useState(false);
  const [showEvidenceForm, setShowEvidenceForm] = useState(false);
  const [evidenceSubmitted, setEvidenceSubmitted] = useState(false);
  const [freighterGuestMode, setFreighterGuestMode] = useState(false);
  const [showCreatedBanner, setShowCreatedBanner] = useState(Boolean(location.state?.created));
  const [coverUploadError] = useState(location.state?.coverUploadError || '');

  // Team & Member state
  const [members, setMembers] = useState([]);
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'viewer' });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState(false);

  // UI state
  const [showQR, setShowQR] = useState(false);
  const [activeTab, setActiveTab] = useState('team');
  const [isEditingCampaign, setIsEditingCampaign] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Analytics state
  const [analytics, setAnalytics] = useState(null);
  const [analyticsTab, setAnalyticsTab] = useState('overview');
  const [backersAnalytics, setBackersAnalytics] = useState(null);
  const [analyticsBackersLoading, setAnalyticsBackersLoading] = useState(false);
  const [referralLeaderboard, setReferralLeaderboard] = useState([]);

  // Refund state
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState('');
  const [refundSuccess, setRefundSuccess] = useState('');

  const currentUserId = user?.id || user?.userId;
  const isOwner = Boolean(
    campaign &&
    (campaign.user_role === 'owner' ||
      (currentUserId && String(campaign.creator_id) === String(currentUserId)))
  );
  const userRole = campaign?.user_role || (isOwner ? 'owner' : null);
  const canManageTeam = userRole === 'owner' || userRole === 'manager';
  const canChangeRoles = userRole === 'owner';
  const canPostUpdate = userRole === 'owner' || userRole === 'manager';
  const canEditCampaign =
    (userRole === 'owner' || userRole === 'editor') &&
    ['active', 'funded'].includes(campaign?.status);
  const canViewAnalytics = userRole === 'owner' || userRole === 'manager' || userRole === 'viewer';
  const acceptedMembers = members.filter((m) => m.accepted_at);
  const pendingInvites = members.filter((m) => !m.accepted_at);

  const campaignUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/campaigns/${id}`;
  const apiBase = (
    import.meta.env.VITE_API_BASE_URL ||
    (typeof window !== 'undefined' ? window.location.origin : '')
  ).replace(/\/+$/, '');
  const widgetEmbedCode = `<iframe src="${typeof window !== 'undefined' ? window.location.origin : ''}/widget/campaigns/${id}" width="320" height="140" frameborder="0" style="border-radius:10px" title="CrowdPay funding widget"></iframe>`;
  const fullEmbedCode = `<iframe src="${typeof window !== 'undefined' ? window.location.origin : ''}/embed/campaigns/${id}" width="480" height="280" frameborder="0" title="CrowdPay campaign embed"></iframe>`;
  const badgeMarkdown = `[![CrowdPay](${apiBase}/api/campaigns/${id}/badge.svg)](${campaignUrl})`;

  const referralUrl = campaign?.referral_code
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/campaigns/${id}?ref=${campaign.referral_code}`
    : null;

  // Load team members and analytics when role allows
  useEffect(() => {
    if (!campaign || !id) return;
    if (canManageTeam) {
      api
        .getCampaignMembers(id)
        .then(setMembers)
        .catch(() => setMembers([]));
    } else {
      setMembers([]);
    }
    if (canViewAnalytics) {
      api
        .getCampaignAnalytics(id)
        .then(setAnalytics)
        .catch(() => setAnalytics(null));
    } else {
      setAnalytics(null);
    }
  }, [id, canManageTeam, canViewAnalytics, campaign]);

  // Load backer insights when analytics tab is 'backers'
  useEffect(() => {
    if (!id || analyticsTab !== 'backers') {
      setBackersAnalytics(null);
      return;
    }
    setAnalyticsBackersLoading(true);
    api
      .getCampaignBackerInsights(id)
      .then(setBackersAnalytics)
      .catch(() => setBackersAnalytics(null))
      .finally(() => setAnalyticsBackersLoading(false));
  }, [id, analyticsTab]);

  // Load referral leaderboard for owner
  useEffect(() => {
    if (!campaign || !id || !isOwner) return;
    if (api.getReferralLeaderboard) {
      api
        .getReferralLeaderboard(id)
        .then((data) =>
          setReferralLeaderboard(Array.isArray(data) ? data : data?.leaderboard || [])
        )
        .catch(() => setReferralLeaderboard([]));
    }
  }, [campaign, id, isOwner]);

  // Live SSE stream
  useEffect(() => {
    if (typeof window === 'undefined' || !window.EventSource || !id) return;

    let es = null;
    let retryDelay = 1000;
    let retryTimeout = null;
    let isUnmounted = false;

    function connect() {
      if (isUnmounted) return;
      es = new EventSource(`/api/campaigns/${id}/stream`);

      es.onopen = () => {
        setIsLive(true);
        retryDelay = 1000;
      };

      es.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === 'contribution') {
          setCampaign((prev) => (prev ? { ...prev, raised_amount: msg.raised_amount } : prev));
          setContributions((prev) => {
            const current = prev || [];
            const exists = current.some((c) => c.tx_hash === msg.contribution.tx_hash);
            if (exists) return current;

            setTotalContributions((t) => t + 1);
            const updated = [msg.contribution, ...current];
            if (!showAll && updated.length > 10) {
              return updated.slice(0, 10);
            }
            return updated;
          });
        }
      };

      es.onerror = () => {
        setIsLive(false);
        if (es) es.close();
        if (!isUnmounted) {
          retryTimeout = setTimeout(() => {
            connect();
            retryDelay = Math.min(retryDelay * 2, 30000);
          }, retryDelay);
        }
      };
    }

    connect();

    return () => {
      isUnmounted = true;
      if (es) es.close();
      if (retryTimeout) clearTimeout(retryTimeout);
      setIsLive(false);
    };
  }, [id, showAll, setCampaign, setContributions, setTotalContributions]);

  // Clean location state
  useEffect(() => {
    if (location.state?.created && typeof window !== 'undefined') {
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  // Page title and SEO meta
  useEffect(() => {
    const DEFAULT_TITLE = 'CrowdPay';
    const DEFAULT_DESCRIPTION = 'Support transparent crowdfunding campaigns on CrowdPay.';

    const updateMeta = (name, content, property = false) => {
      let el = document.querySelector(
        property ? `meta[property="${name}"]` : `meta[name="${name}"]`
      );
      if (!el) {
        el = document.createElement('meta');
        if (property) el.setAttribute('property', name);
        else el.setAttribute('name', name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    const removeMeta = (name, property = false) => {
      const el = document.querySelector(
        property ? `meta[property="${name}"]` : `meta[name="${name}"]`
      );
      if (el) el.remove();
    };

    if (!campaign || campaign.is_hidden) {
      document.title = DEFAULT_TITLE;
      updateMeta('description', DEFAULT_DESCRIPTION);
      updateMeta('og:type', 'website', true);
      updateMeta('og:title', DEFAULT_TITLE, true);
      updateMeta('og:description', DEFAULT_DESCRIPTION, true);
      updateMeta('og:url', window.location.href, true);
      removeMeta('og:image', true);
      removeMeta('twitter:image');
      updateMeta('twitter:card', 'summary');
      updateMeta('twitter:title', DEFAULT_TITLE);
      updateMeta('twitter:description', DEFAULT_DESCRIPTION);
      return;
    }

    const tTitle = translation?.title || campaign.title || DEFAULT_TITLE;
    const tDesc = translation?.description || campaign.description || DEFAULT_DESCRIPTION;
    const imageUrl = campaign.cover_image_url || campaign.og_image_url || '';

    document.title = `${tTitle} | CrowdPay`;
    updateMeta('description', tDesc);
    updateMeta('og:type', 'website', true);
    updateMeta('og:title', tTitle, true);
    updateMeta('og:description', tDesc, true);
    updateMeta('og:url', window.location.href, true);
    if (imageUrl) {
      updateMeta('og:image', imageUrl, true);
      updateMeta('twitter:image', imageUrl);
    } else {
      removeMeta('og:image', true);
      removeMeta('twitter:image');
    }
    updateMeta('twitter:card', imageUrl ? 'summary_large_image' : 'summary');
    updateMeta('twitter:title', tTitle);
    updateMeta('twitter:description', tDesc);
  }, [campaign, translation]);

  async function handleFreighterContribute() {
    try {
      const connected = await isConnected()
        .then((r) => r?.isConnected ?? r)
        .catch(() => false);
      if (!connected) {
        window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
        return;
      }
      setFreighterGuestMode(true);
      setShowModal(true);
    } catch {
      window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
    }
  }

  async function handleClone() {
    try {
      const data = await api.getCloneData(id);
      navigate('/campaigns/new', { state: { prefill: data } });
    } catch (err) {
      window.alert(err.message || 'Failed to fetch campaign clone data');
    }
  }

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
      const newMember = await api.inviteCampaignMember(id, inviteForm);
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
      const updated = await api.updateCampaignMemberRole(id, userId, { role: newRole });
      setMembers((prev) =>
        prev.map((m) => (m.user_id === userId ? { ...m, role: updated.role } : m))
      );
    } catch (err) {
      window.alert(err.message || 'Failed to update role');
    }
  }

  async function handleRemoveMember(userId) {
    if (!window.confirm('Are you sure you want to remove this member?')) return;
    try {
      await api.removeCampaignMember(id, userId);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      window.alert(err.message || 'Failed to remove member');
    }
  }

  async function handleResendInvite(memberId) {
    try {
      const updated = await api.resendCampaignInvite(id, memberId);
      setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, ...updated } : m)));
    } catch (err) {
      window.alert(err.message || 'Failed to resend invitation');
    }
  }

  async function handleCancelInvite(memberId) {
    if (!window.confirm('Cancel this pending invitation?')) return;
    try {
      await api.cancelCampaignInvite(id, memberId);
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    } catch (err) {
      window.alert(err.message || 'Failed to cancel invitation');
    }
  }

  async function handleInitiateRefund() {
    setRefundBusy(true);
    setRefundError('');
    setRefundSuccess('');
    try {
      const initRes = await api.initiateRefund(campaign.id);
      const unsignedXdr = initRes.unsigned_xdr;

      if (user?.wallet_type === 'freighter') {
        const network = await getNetwork();
        if (network?.error) throw new Error('Could not read Freighter network');

        const signed = await signTransaction(unsignedXdr, {
          networkPassphrase: network?.networkPassphrase,
          address: user?.wallet_public_key,
        });
        if (signed?.error) throw new Error(signed.error?.message || 'Freighter signing failed');
        if (!signed?.signedTxXdr) throw new Error('Freighter did not return a signed transaction');

        await api.approveRefundCreator(campaign.id, {
          signed_xdr: signed.signedTxXdr,
        });
      } else {
        await api.approveRefundCreator(campaign.id, {});
      }

      let isPlatformApprover = false;
      try {
        const capRes = await api.getWithdrawalCapabilities();
        if (capRes.can_approve_platform) {
          isPlatformApprover = true;
        }
      } catch {
        // ignore
      }

      if (isPlatformApprover) {
        await api.approveRefundPlatform(campaign.id);
        setRefundSuccess('Campaign contributions successfully refunded!');
      } else {
        setRefundSuccess('Refund signed by creator. Awaiting platform release.');
      }

      const updatedCampaign = await api.getCampaign(campaign.id);
      setCampaign(updatedCampaign);
    } catch (err) {
      setRefundError(err.message || 'Failed to initiate refund.');
    } finally {
      setRefundBusy(false);
    }
  }

  async function handleDeleteCampaign() {
    setDeleteError('');
    if (!campaign) return;

    if (deleteConfirmation !== campaign.title) {
      setDeleteError('Confirmation does not match campaign title');
      return;
    }

    try {
      setDeleteLoading(true);
      await api.deleteCampaign(campaign.id, token);
      setShowDeleteDialog(false);
      setDeleteConfirmation('');
      window.location.href = '/';
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete campaign');
    } finally {
      setDeleteLoading(false);
    }
  }

  if (loadError && !campaign) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '2.5rem' }}>
        <p className="alert alert--error" role="alert">
          {loadError}
        </p>
        <Link to="/discover" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          Back to campaigns
        </Link>
      </main>
    );
  }

  if (!campaign) {
    return <CampaignDetailSkeleton />;
  }

  const pct = Math.min(100, (campaign.raised_amount / campaign.target_amount) * 100).toFixed(1);

  return (
    <main
      className="container"
      style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}
    >
      {showCreatedBanner && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>{t('campaign.createdBanner')}</strong> {t('campaign.createdBannerBody')}
          <button
            type="button"
            onClick={() => setShowCreatedBanner(false)}
            style={{
              marginLeft: '0.5rem',
              background: 'transparent',
              color: 'var(--color-success-text)',
              textDecoration: 'underline',
              fontWeight: 600,
              padding: 0,
              minHeight: 'auto',
            }}
          >
            {t('common.dismiss')}
          </button>
        </div>
      )}
      {coverUploadError && (
        <div className="alert alert--warning" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>{t('campaign.coverUploadFailed')}</strong> {coverUploadError}
        </div>
      )}
      {campaign.status === 'funded' && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>{t('campaign.goalReached')}</strong> {t('campaign.goalReachedBody')}
        </div>
      )}
      {campaign.status === 'failed' && (
        <div className="alert alert--error" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>{t('campaign.campaignEnded')}</strong> {t('campaign.campaignEndedBody')}
        </div>
      )}
      {campaign.status === 'refunded' && (
        <div className="alert alert--success" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>{t('campaign.campaignRefunded')}</strong> {t('campaign.campaignRefundedBody')}
        </div>
      )}
      {campaign.status === 'failed' && user && user.id === campaign.creator_id && (
        <div
          style={{
            background: 'var(--color-bg-card, #1e1e2f)',
            border: '1px solid var(--color-border-light)',
            borderRadius: '10px',
            padding: '1.1rem 1.25rem',
            marginBottom: '1.25rem',
          }}
        >
          <p
            style={{
              margin: '0 0 0.75rem',
              fontSize: '0.9rem',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.55,
            }}
          >
            {t('campaign.campaignEndedBody')}
          </p>
          {refundError && (
            <p
              className="alert alert--error"
              style={{ marginBottom: '0.75rem', fontSize: '0.875rem' }}
              role="alert"
            >
              {refundError}
            </p>
          )}
          {refundSuccess && (
            <p
              className="alert alert--success"
              style={{ marginBottom: '0.75rem', fontSize: '0.875rem' }}
              role="status"
            >
              {refundSuccess}
            </p>
          )}
          <button
            id="btn-refund-contributors"
            type="button"
            className="btn-primary"
            disabled={refundBusy}
            onClick={handleInitiateRefund}
            style={{
              background: refundBusy ? undefined : 'var(--color-status-error)',
              borderColor: refundBusy ? undefined : 'var(--color-status-error)',
              fontSize: '0.9rem',
            }}
          >
            {refundBusy ? t('campaign.processingRefund') : t('campaign.refundContributors')}
          </button>
        </div>
      )}
      {campaign.creator_kyc_status !== 'verified' && (
        <div className="alert alert--warning" style={{ marginBottom: '1.25rem' }} role="status">
          <strong>{t('campaign.legacyCampaign')}</strong> {t('campaign.legacyCampaignDescription')}
        </div>
      )}

      {campaign.cover_image_url && (
        <img src={campaign.cover_image_url} alt={campaign.title} style={styles.detailCoverImage} />
      )}
      {!campaign.cover_image_url && (
        <div style={styles.detailCoverPlaceholder} aria-hidden="true">
          <span style={styles.detailCoverPlaceholderText}>{t('campaign.noImage')}</span>
        </div>
      )}

      <div style={styles.header}>
        <div style={styles.badgeRow}>
          <span style={styles.asset}>{campaign.asset_type}</span>
          <CampaignStatusBadge status={campaign.status} />
          <VerificationBadge
            status={campaign.creator_kyc_status || campaign.creator_verification_status}
            tier={campaign.creator_verification_tier}
            showTier
          />
          {user && <FavoriteToggle campaignId={campaign.id} />}
          {user && <FollowCampaignButton campaignId={campaign.id} />}
          {campaign.contract_address && (
            <span
              title="This campaign is backed by a Soroban smart contract"
              style={{
                background: 'var(--color-success-bg)',
                color: 'var(--color-success-text)',
                borderRadius: '999px',
                fontSize: '0.72rem',
                fontWeight: 700,
                padding: '0.25rem 0.6rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              On-chain verified
            </span>
          )}
        </div>

        <LanguageToggle
          campaignId={campaign.id}
          defaultLanguage={campaign.locale || currentLocale}
          defaultTitle={campaign.title}
          defaultDescription={campaign.description || ''}
          onTranslationChange={setTranslation}
        />

        {campaign.status === 'disputed' && (
          <div
            className="alert alert--error"
            role="status"
            style={{ marginBottom: '1rem', display: 'grid', gap: '0.5rem' }}
          >
            <strong>{t('campaign.openDispute')}</strong>
            <span style={{ fontSize: '0.85rem' }}>
              New contributions are paused and the escrow is frozen while the platform reviews the
              case.
            </span>
            {activeDispute &&
              (evidenceSubmitted ? (
                <span style={{ fontSize: '0.85rem' }}>Your evidence has been submitted.</span>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: '0.85rem', width: 'fit-content' }}
                  onClick={() => setShowEvidenceForm(true)}
                >
                  Submit evidence
                </button>
              ))}
          </div>
        )}

        <h1 style={styles.title}>{translation?.title || campaign.title}</h1>
        {campaign.creator_name && <p style={styles.creator}>by {campaign.creator_name}</p>}
        <div
          style={{ ...styles.desc, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(
              markdownToHtml(translation?.description || campaign.description)
            ),
          }}
        />
      </div>

      {campaign.wallet_mode === 'contract' && (
        <div style={{ ...styles.card, marginBottom: '1rem' }}>
          <TreasuryTransparencyPanel campaignId={campaign.id} assetType={campaign.asset_type} />
        </div>
      )}

      {/* Rewards Tab: NFT proof of support and Reward Tiers */}
      <CampaignRewardsTab nftRewards={nftRewards} tiers={tiers} formatNaira={formatNaira} />

      {/* Campaign Funding Progress Card */}
      <div style={styles.card}>
        <div style={styles.amounts}>
          <div>
            <div style={styles.big}>
              {Number(campaign.raised_amount).toLocaleString()} {campaign.asset_type}
              {nairaRaised && (
                <span
                  style={styles.nairaBig}
                  title="Approximate NGN value"
                  aria-label={`approximate naira value: ₦${nairaRaised}`}
                >
                  {' '}
                  (≈ ₦{nairaRaised} approx.)
                </span>
              )}
            </div>
            <div style={styles.small}>
              raised of {Number(campaign.target_amount).toLocaleString()} {campaign.asset_type}{' '}
              {nairaTarget && (
                <span
                  style={styles.nairaSmall}
                  title="Approximate NGN value"
                  aria-label={`approximate naira goal: ₦${nairaTarget}`}
                >
                  (≈ ₦{nairaTarget} approx.){' '}
                </span>
              )}
              goal
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={styles.big}>{pct}%</div>
            <div style={styles.small}>
              {t('campaign.fundedByBackers', { count: campaign.contributor_count || 0 })}
            </div>
          </div>
        </div>
        <div
          role="progressbar"
          className="campaign-progress-bar"
          aria-valuenow={Number(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pct}% of goal raised`}
          style={styles.bar}
        >
          <div
            style={{
              ...styles.fill,
              background: progressColor(parseFloat(pct), campaign.status),
              width: `${pct}%`,
            }}
            aria-hidden="true"
          />
        </div>

        {campaign.status === 'refunded' ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
            {t('campaign.refundedCampaignNotice')}
          </p>
        ) : ['failed', 'closed', 'withdrawn'].includes(campaign.status) ? (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
            {t('campaign.contributionsClosedStatus', { status: campaign.status })}
          </p>
        ) : user ? (
          <>
            <ContributorEligibilityBadge user={user} campaignId={campaign.id} />
            <button
              type="button"
              className="btn-primary"
              style={styles.cta}
              ref={contributeBtnRef}
              aria-label={`Contribute to ${campaign.title}`}
              onClick={() => setShowModal(true)}
            >
              Contribute
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <CampaignRequirementsNotice campaignId={campaign.id} />
            <Link
              to="/login"
              state={{ from: `/campaigns/${id}` }}
              className="btn-primary"
              style={{
                ...styles.cta,
                textAlign: 'center',
                textDecoration: 'none',
                display: 'block',
              }}
            >
              Log in to contribute
            </Link>
            <button
              type="button"
              className="btn-secondary"
              style={styles.cta}
              onClick={handleFreighterContribute}
            >
              Contribute with Freighter
            </button>
          </div>
        )}

        {campaign.status === 'active' && (
          <div style={{ marginTop: '1.5rem' }}>
            <PoolManager campaignId={id} campaignTitle={campaign.title} />
          </div>
        )}

        {user && (
          <button
            type="button"
            className="btn-secondary"
            style={{ ...styles.cta, marginTop: '0.75rem' }}
            onClick={handleClone}
          >
            Clone campaign
          </button>
        )}
      </div>

      {/* Social Sharing Bar */}
      <CampaignShareBar campaign={campaign} referralUrl={referralUrl} toast={toast} />

      {/* Draft controls */}
      {user && campaign && isOwner && (
        <CampaignPublishControls campaign={campaign} isOwner={isOwner} navigate={navigate} />
      )}

      {/* Edit / Delete Buttons */}
      {user && campaign && canEditCampaign && (
        <div
          data-no-print
          style={{
            display: 'flex',
            gap: '0.65rem',
            marginBottom: '1.75rem',
          }}
        >
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
            onClick={() => setIsEditingCampaign(true)}
          >
            Edit Campaign
          </button>
          {isOwner && campaign.status === 'active' && !hasPendingWithdrawal && (
            <button
              type="button"
              className="btn-secondary"
              style={{
                color: 'var(--color-status-error)',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
              }}
              onClick={() => setShowDeleteDialog(true)}
            >
              Delete campaign
            </button>
          )}
        </div>
      )}

      {/* Campaign Wallet Info & QR Code */}
      <div style={styles.walletInfo}>
        <span style={styles.walletLabel}>Campaign wallet</span>
        <code style={styles.walletKey}>{campaign.wallet_public_key}</code>
      </div>

      <div style={{ marginBottom: '1.75rem' }}>
        <button
          type="button"
          className="btn-secondary"
          data-no-print
          aria-expanded={showQR}
          onClick={() => setShowQR((v) => !v)}
        >
          {showQR ? 'Hide QR code' : 'Show QR code'}
        </button>
        {showQR && (
          <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
            <CampaignQRCode
              url={referralUrl || `${window.location.origin}/campaigns/${id}`}
              size={200}
            />
          </div>
        )}
      </div>

      {/* Embed Section */}
      <CampaignEmbedSection
        campaignId={campaign.id}
        widgetEmbedCode={widgetEmbedCode}
        fullEmbedCode={fullEmbedCode}
        badgeMarkdown={badgeMarkdown}
        canPostUpdate={canPostUpdate}
      />

      {/* Report a problem */}
      {user &&
        contributions?.some((c) => c.sender_public_key) &&
        campaign.creator_id !== user.id && (
          <div style={{ marginBottom: '1.25rem' }} data-no-print>
            {disputeSubmitted ? (
              <p className="alert alert--success" role="status">
                Your dispute has been submitted. The platform team will review it shortly.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setShowDisputeModal(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-status-error)',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  padding: 0,
                  textDecoration: 'underline',
                }}
              >
                Report a problem with this campaign
              </button>
            )}
          </div>
        )}

      {/* About Tab: Milestones, Stretch Goals, Budget, Withdrawals, Survey */}
      <CampaignAboutTab
        campaign={campaign}
        milestones={milestones}
        setMilestones={setMilestones}
        stretchGoals={stretchGoals}
        user={user}
        token={token}
        canEditCampaign={canEditCampaign}
        canManageTeam={canManageTeam}
        setCampaign={setCampaign}
      />

      {/* Team / Analytics Manager Tabs */}
      {canManageTeam && (
        <div style={{ marginBottom: '2rem' }} data-no-print>
          <div
            role="tablist"
            style={{
              display: 'flex',
              gap: '0.5rem',
              marginBottom: '1rem',
              borderBottom: '1px solid var(--color-border-lighter)',
              paddingBottom: '0.5rem',
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'team'}
              onClick={() => setActiveTab('team')}
              style={{
                background: activeTab === 'team' ? 'var(--color-accent)' : 'transparent',
                color: activeTab === 'team' ? 'var(--color-bg)' : 'var(--color-text-primary)',
                border: '1px solid var(--color-border-light)',
                borderRadius: '6px',
                padding: '0.4rem 0.9rem',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Team
            </button>
            {canViewAnalytics && (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'analytics'}
                onClick={() => setActiveTab('analytics')}
                style={{
                  background: activeTab === 'analytics' ? 'var(--color-accent)' : 'transparent',
                  color:
                    activeTab === 'analytics' ? 'var(--color-bg)' : 'var(--color-text-primary)',
                  border: '1px solid var(--color-border-light)',
                  borderRadius: '6px',
                  padding: '0.4rem 0.9rem',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Analytics
              </button>
            )}
          </div>

          {activeTab === 'team' && (
            <CampaignTeamTab
              campaign={campaign}
              isOwner={isOwner}
              canChangeRoles={canChangeRoles}
              user={user}
              inviteForm={inviteForm}
              setInviteForm={setInviteForm}
              inviteBusy={inviteBusy}
              inviteError={inviteError}
              inviteSuccess={inviteSuccess}
              handleInviteSubmit={handleInviteSubmit}
              pendingInvites={pendingInvites}
              acceptedMembers={acceptedMembers}
              handleResendInvite={handleResendInvite}
              handleCancelInvite={handleCancelInvite}
              handleRoleChange={handleRoleChange}
              handleRemoveMember={handleRemoveMember}
            />
          )}
        </div>
      )}

      {/* Analytics Section */}
      {canViewAnalytics && (canManageTeam ? activeTab === 'analytics' : true) && (
        <CampaignAnalyticsTab
          campaign={campaign}
          user={user}
          analytics={analytics}
          analyticsTab={analyticsTab}
          setAnalyticsTab={setAnalyticsTab}
          backersAnalytics={backersAnalytics}
          analyticsBackersLoading={analyticsBackersLoading}
        />
      )}

      {/* Referral Leaderboard */}
      {isOwner && referralLeaderboard && referralLeaderboard.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={styles.sectionTitle}>Referral Leaderboard</h2>
          <div className="campaign-card">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border)', textAlign: 'left' }}>
                  <th style={{ padding: '0.5rem 0.75rem' }}>#</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Referrer</th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Clicks</th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Contributions</th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>Conv. Rate</th>
                </tr>
              </thead>
              <tbody>
                {referralLeaderboard.map((r, i) => (
                  <tr
                    key={r.referral_code}
                    style={{ borderBottom: '1px solid var(--color-border-lighter)' }}
                  >
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--color-text-hint)' }}>
                      {i + 1}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>
                      {r.referrer_name}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                      {r.click_count}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                      {r.contribution_count}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                      {r.click_count > 0
                        ? `${((r.contribution_count / r.click_count) * 100).toFixed(0)}%`
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Updates Tab */}
      <CampaignUpdatesTab
        updates={updates}
        canPostUpdate={canPostUpdate}
        submitUpdate={submitUpdate}
        editingUpdateId={editingUpdateId}
        setEditingUpdateId={setEditingUpdateId}
        updateForm={updateForm}
        setUpdateForm={setUpdateForm}
        updateBusy={updateBusy}
        updatesError={updatesError}
        setUpdatesError={setUpdatesError}
        deleteUpdate={deleteUpdate}
        startEditUpdate={startEditUpdate}
        maxBodyLength={UPDATE_BODY_MAX}
        warnThreshold={UPDATE_BODY_WARN_THRESHOLD}
      />

      {/* Comments Tab */}
      <CampaignCommentsTab campaignId={campaign.id} campaign={campaign} />

      {/* Contributions Tab / Backer Wall */}
      <CampaignContributionsTab
        contributions={contributions}
        totalContributions={totalContributions}
        isLive={isLive}
        showAll={showAll}
        setShowAll={setShowAll}
      />

      {/* Modals & Dialogs */}
      {showModal && (
        <ContributeModal
          campaign={campaign}
          tiers={tiers}
          referralCode={refParam}
          initialAmount={presetAmount}
          guestFreighterMode={freighterGuestMode}
          onClose={() => {
            setShowModal(false);
            setFreighterGuestMode(false);
            contributeBtnRef.current?.focus();
          }}
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

      {showEvidenceForm && activeDispute && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="evidence-form-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'var(--color-bg)',
              borderRadius: '12px',
              padding: '1.75rem',
              width: '100%',
              maxWidth: '480px',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h2
              id="evidence-form-title"
              style={{ fontSize: '1.2rem', fontWeight: 700, marginTop: 0 }}
            >
              Submit evidence
            </h2>
            <EvidenceForm
              disputeId={activeDispute.id}
              onClose={() => setShowEvidenceForm(false)}
              onSubmitted={() => setEvidenceSubmitted(true)}
            />
          </div>
        </div>
      )}

      <CampaignEditModal
        isOpen={isEditingCampaign}
        campaign={campaign}
        onClose={() => setIsEditingCampaign(false)}
        onSaved={refreshCampaign}
        token={token}
        milestones={milestones}
        setMilestones={setMilestones}
        currentLocale={currentLocale}
      />

      {showDeleteDialog && campaign && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-campaign-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            ref={deleteModalRef}
            style={{
              background: 'var(--color-surface)',
              borderRadius: '8px',
              padding: '2rem',
              maxWidth: '500px',
              width: '90%',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            }}
          >
            <h2
              id="delete-campaign-title"
              style={{
                fontSize: '1.5rem',
                fontWeight: 700,
                marginBottom: '1rem',
                color: 'var(--color-text-primary)',
              }}
            >
              Delete Campaign
            </h2>
            <p
              style={{
                fontSize: '0.95rem',
                color: 'var(--color-text-secondary)',
                marginBottom: '1.5rem',
                lineHeight: 1.5,
              }}
            >
              Are you sure you want to delete this campaign? This action cannot be undone. All
              contribution and withdrawal history will be preserved, but the campaign will no longer
              be visible to the public.
            </p>
            <div style={{ marginBottom: '1.5rem' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.5rem',
                  fontSize: '0.9rem',
                  color: 'var(--color-text-primary)',
                }}
              >
                Type the campaign title to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder={campaign.title}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border)',
                  borderRadius: '4px',
                  fontSize: '1rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            {deleteError && (
              <p className="alert alert--error" style={{ marginBottom: '1.5rem' }}>
                {deleteError}
              </p>
            )}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowDeleteDialog(false);
                  setDeleteConfirmation('');
                  setDeleteError('');
                }}
                disabled={deleteLoading}
                style={{ opacity: deleteLoading ? 0.6 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleDeleteCampaign}
                disabled={deleteLoading || deleteConfirmation !== campaign.title}
                style={{
                  opacity: deleteLoading || deleteConfirmation !== campaign.title ? 0.6 : 1,
                  background: 'var(--color-status-error)',
                  borderColor: 'var(--color-status-error)',
                }}
              >
                {deleteLoading ? 'Deleting...' : 'Delete Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {(isOwner || user?.role === 'admin') && campaign && (
        <RefundsSection
          campaign={campaign}
          user={user}
          onRefundSuccess={() => {
            api
              .getCampaign(id)
              .then(setCampaign)
              .catch(() => {});
          }}
        />
      )}
    </main>
  );
}

const styles = {
  header: { marginBottom: '1.5rem' },
  badgeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  asset: {
    background: 'var(--color-accent-lightest)',
    color: 'var(--color-accent)',
    fontSize: '0.75rem',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: '99px',
  },
  title: {
    fontSize: '1.8rem',
    fontWeight: 800,
    margin: '0.5rem 0',
    color: 'var(--color-text-primary)',
  },
  creator: { color: 'var(--color-text-hint)', fontSize: '0.9rem', marginBottom: '0.5rem' },
  desc: { color: 'var(--color-text-secondary)', fontSize: '1rem', lineHeight: 1.6 },
  card: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '1.5rem',
    marginBottom: '1rem',
  },
  amounts: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '1rem',
  },
  big: { fontSize: '1.5rem', fontWeight: 800, color: 'var(--color-text-primary)' },
  small: { fontSize: '0.85rem', color: 'var(--color-text-muted)' },
  nairaBig: {
    fontSize: '0.95rem',
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
    marginLeft: '0.35rem',
    verticalAlign: 'middle',
  },
  nairaSmall: {
    fontSize: '0.8rem',
    color: 'var(--color-text-secondary)',
    fontWeight: 500,
  },
  bar: {
    background: 'var(--color-surface)',
    borderRadius: '99px',
    height: '8px',
    marginBottom: '1.25rem',
    overflow: 'hidden',
  },
  fill: { background: 'var(--color-accent)', height: '100%', borderRadius: '99px' },
  cta: { width: '100%', padding: '0.85rem', fontSize: '1rem' },
  walletInfo: {
    background: 'var(--color-surface)',
    borderRadius: '8px',
    padding: '0.75rem 1rem',
    marginBottom: '1.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  walletLabel: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    textTransform: 'uppercase',
  },
  walletKey: { fontSize: '0.8rem', color: 'var(--color-text-secondary)', wordBreak: 'break-all' },
  detailCoverImage: {
    width: '100%',
    borderRadius: '14px',
    marginBottom: '1.5rem',
    objectFit: 'cover',
    maxHeight: '360px',
  },
  detailCoverPlaceholder: {
    width: '100%',
    borderRadius: '14px',
    marginBottom: '1.5rem',
    height: '260px',
    background:
      'linear-gradient(135deg, var(--color-accent-lighter) 0%, var(--color-accent-lightest) 100%)',
    border: '1px solid var(--color-purple-light)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailCoverPlaceholderText: { color: 'var(--color-accent-hover)', fontWeight: 700 },
  sectionTitle: {
    fontSize: '1.1rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
};
