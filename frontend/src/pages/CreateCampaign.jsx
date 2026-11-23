import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import OnboardingCallout from '../components/OnboardingCallout';
import KycPrompt from '../components/KycPrompt';
import { isCreatorOnboardingVisible, dismissCreatorOnboarding } from '../lib/onboarding';
import { saveDraft, loadDraft, clearDraft, hasDraftContent } from '../lib/campaignDraft';
import {
  emptyMilestone,
  emptyTier,
  milestonePercentTotal,
  stepOneError,
  stepTwoError,
  milestonesError,
  tiersError,
} from '../lib/campaignValidation';
import CreateCampaignStepGoal from '../components/campaign/create/CreateCampaignStepGoal';
import CreateCampaignStepDetails from '../components/campaign/create/CreateCampaignStepDetails';
import CreateCampaignStepMilestones from '../components/campaign/create/CreateCampaignStepMilestones';

const DRAFT_SAVE_DEBOUNCE_MS = 800;
const SERVER_DRAFT_SAVE_MS = 30_000;

export default function CreateCampaign() {
  const { t } = useTranslation();
  const { user, ready, updateUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState(1);
  const [translations, setTranslations] = useState({});
  const [activeTranslationLocale, setActiveTranslationLocale] = useState(null);
  const [form, setForm] = useState({
    title: location.state?.prefill?.title || '',
    description: location.state?.prefill?.description || '',
    target_amount: location.state?.prefill?.target_amount || '',
    asset_type: location.state?.prefill?.asset_type || 'USDC',
    deadline: '',
    category: '',
    country: '',
    min_contribution: location.state?.prefill?.min_contribution || '',
    max_contribution: location.state?.prefill?.max_contribution || '',
    max_per_user: location.state?.prefill?.max_per_user || '',
    show_backer_amounts: location.state?.prefill?.show_backer_amounts ?? true,
    template_id: '',
    // Soroban treasury (#687). 'standard' keeps the threshold-2 multisig wallet;
    // 'contract' deploys a treasury contract that enforces the policy below.
    wallet_mode: 'standard',
    treasury_policy: {
      minHoldDays: 0,
      maxSingleWithdrawalPct: 100,
      withdrawalCooldownHours: 0,
      requireAuditorForAbove: '0',
      autoRefundOnMiss: false,
    },
    milestones: [],
    reward_tiers: [],
  });
  const [coverImageFile, setCoverImageFile] = useState(null);
  const [coverImagePreview, setCoverImagePreview] = useState('');
  const [isDragOverCover, setIsDragOverCover] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState(null);
  const today = new Date().toISOString().split('T')[0];
  const [showCreatorTips, setShowCreatorTips] = useState(isCreatorOnboardingVisible);
  // A draft found in storage on load. Auto-save stays paused until the creator
  // restores or discards it, so an untouched form cannot overwrite it.
  const [pendingDraft, setPendingDraft] = useState(() =>
    location.state?.prefill ? null : loadDraft()
  );
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftId, setDraftId] = useState(null);
  const [templates, setTemplates] = useState([]);

  // Local storage save (immediate indicator, updated by server save)
  const localSaveTimer = useRef(null);

  useEffect(() => {
    if (pendingDraft) return;
    if (!hasDraftContent(form)) return;

    if (localSaveTimer.current) clearTimeout(localSaveTimer.current);
    localSaveTimer.current = setTimeout(() => {
      const draft = saveDraft(form, step);
      if (draft && !draftId) setDraftSavedAt(draft.saved_at);
    }, DRAFT_SAVE_DEBOUNCE_MS);

    return () => {
      if (localSaveTimer.current) clearTimeout(localSaveTimer.current);
    };
  }, [form, step, pendingDraft, draftId]);

  // Server auto-save every 30s (debounced, with indicator)
  const serverSaveTimer = useRef(null);

  useEffect(() => {
    if (pendingDraft) return;
    if (!hasDraftContent(form)) return;
    if (!user) return;

    if (serverSaveTimer.current) clearTimeout(serverSaveTimer.current);

    serverSaveTimer.current = setTimeout(async () => {
      setDraftSaving(true);
      try {
        const result = await api.saveCampaignDraft({ form_data: form, step });
        setDraftId(result.id);
        setDraftSavedAt(result.saved_at);
        saveDraft(form, step);
      } catch {
        // server save failed — local storage is the fallback
      }
      setDraftSaving(false);
    }, SERVER_DRAFT_SAVE_MS);

    return () => {
      if (serverSaveTimer.current) clearTimeout(serverSaveTimer.current);
    };
  }, [form, step, pendingDraft, user]);

  // On mount, check for a server draft and offer to restore it
  useEffect(() => {
    if (!user) return;
    if (location.state?.prefill) return;

    let cancelled = false;

    api
      .getMyCampaignDraft()
      .then((serverDraft) => {
        if (cancelled) return;
        const localDraft = loadDraft();

        const serverTime = new Date(serverDraft.saved_at).getTime();
        const localTime = localDraft ? new Date(localDraft.saved_at).getTime() : 0;

        if (serverTime > localTime) {
          setPendingDraft({
            form: serverDraft.form_data,
            step: serverDraft.step,
            saved_at: serverDraft.saved_at,
          });
          setDraftId(serverDraft.id);
        } else if (localDraft) {
          setDraftId(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
      });

    return () => {
      cancelled = true;
    };
  }, [user, location.state?.prefill]);

  function restoreDraft() {
    setForm(pendingDraft.form);
    setStep(pendingDraft.step || 1);
    setDraftSavedAt(pendingDraft.saved_at);
    setPendingDraft(null);
  }

  function discardDraft() {
    if (draftId) {
      api.deleteCampaignDraft(draftId).catch(() => {});
    }
    clearDraft();
    setPendingDraft(null);
    setDraftSavedAt(null);
    setDraftId(null);
  }

  function discardCurrentDraft() {
    if (draftId) {
      api.deleteCampaignDraft(draftId).catch(() => {});
    }
    clearDraft();
    setDraftSavedAt(null);
    setDraftId(null);
    setForm({
      title: '',
      description: '',
      target_amount: '',
      asset_type: 'USDC',
      deadline: '',
      category: '',
      country: '',
      min_contribution: '',
      max_contribution: '',
      max_per_user: '',
      show_backer_amounts: true,
      template_id: '',
      milestones: [],
      reward_tiers: [],
      min_reputation_score: 0,
      required_attestations: [],
    });
    setStep(1);
    setError('');
  }

  useEffect(() => {
    if (ready && !user) {
      navigate('/login', { replace: true, state: { from: '/campaigns/new' } });
    }
  }, [ready, user, navigate]);

  useEffect(() => {
    if (!user) return;
    api
      .getMe()
      .then(updateUser)
      .catch(() => {});
  }, [user, updateUser]);

  useEffect(() => {
    let cancelled = false;
    api
      .getCampaignTemplates()
      .then((result) => {
        if (!cancelled) setTemplates(Array.isArray(result) ? result : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function setField(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function updateTreasuryPolicy(field, value) {
    setForm((f) => ({ ...f, treasury_policy: { ...f.treasury_policy, [field]: value } }));
  }

  function setDescription(value) {
    setForm((f) => ({ ...f, description: value }));
  }

  function selectAsset(value) {
    setForm((f) => ({ ...f, asset_type: value }));
  }

  function applyTemplate(templateId) {
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      setForm((f) => ({ ...f, template_id: '' }));
      return;
    }
    const data = template.template_data || {};
    setForm((f) => ({
      ...f,
      template_id: template.id,
      title: data.title || f.title,
      description: data.description || f.description,
      target_amount: data.target_amount || f.target_amount,
      category: template.category || f.category,
      milestones: Array.isArray(data.milestones) ? data.milestones : f.milestones,
      reward_tiers: Array.isArray(data.reward_tiers) ? data.reward_tiers : f.reward_tiers,
    }));
    setError('');
  }

  function setCoverImage(file) {
    if (!file) {
      setCoverImageFile(null);
      setCoverImagePreview('');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Cover image must be JPG, PNG, or WEBP.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Cover image must be smaller than 5MB.');
      return;
    }
    setCoverImageFile(file);
    setError('');
    const reader = new FileReader();
    reader.onload = () => setCoverImagePreview(reader.result || '');
    reader.readAsDataURL(file);
  }

  function handleCoverImageChange(e) {
    setCoverImage(e.target.files?.[0] || null);
  }

  function handleCoverImageDrop(e) {
    e.preventDefault();
    setIsDragOverCover(false);
    const file = e.dataTransfer?.files?.[0] || null;
    setCoverImage(file);
  }

  function dismissTips() {
    dismissCreatorOnboarding();
    setShowCreatorTips(false);
  }

  function setMilestoneField(index, field, value) {
    setForm((f) => ({
      ...f,
      milestones: f.milestones.map((milestone, milestoneIndex) =>
        milestoneIndex === index ? { ...milestone, [field]: value } : milestone
      ),
    }));
  }

  function addMilestone() {
    setForm((f) => {
      if (f.milestones.length >= 5) return f;
      return { ...f, milestones: [...f.milestones, emptyMilestone()] };
    });
  }

  function removeMilestone(index) {
    setForm((f) => ({
      ...f,
      milestones: f.milestones.filter((_, milestoneIndex) => milestoneIndex !== index),
    }));
  }

  function setTierField(index, field, value) {
    setForm((f) => ({
      ...f,
      reward_tiers: f.reward_tiers.map((tier, tierIndex) =>
        tierIndex === index ? { ...tier, [field]: value } : tier
      ),
    }));
  }

  function addTier() {
    setForm((f) => {
      if (f.reward_tiers.length >= 10) return f;
      return { ...f, reward_tiers: [...f.reward_tiers, emptyTier()] };
    });
  }

  function removeTier(index) {
    setForm((f) => ({
      ...f,
      reward_tiers: f.reward_tiers.filter((_, tierIndex) => tierIndex !== index),
    }));
  }

  function applyValidation(...messages) {
    const message = messages.find(Boolean);
    if (message) {
      setError(message);
      return false;
    }
    setError('');
    return true;
  }

  function validateStep1() {
    return applyValidation(stepOneError(form));
  }

  function validateStep2() {
    return applyValidation(stepTwoError(form));
  }

  function validateMilestones() {
    return applyValidation(milestonesError(form));
  }

  function validateTiers() {
    return applyValidation(tiersError(form, today));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validateStep1() || !validateStep2() || !validateMilestones() || !validateTiers()) return;

    if (!duplicateWarning) {
      setLoading(true);
      try {
        const checkRes = await api.checkDuplicateCampaign({
          title: form.title.trim(),
          description: form.description.trim(),
        });
        if (checkRes.isDuplicate) {
          setDuplicateWarning(
            `This campaign resembles an existing campaign: "${checkRes.similarTo}". It will be flagged for admin review.`
          );
          setLoading(false);
          return;
        }
      } catch {
        // ignore error and proceed
      }
    }

    setLoading(true);
    setError('');
    try {
      let formattedDeadline = undefined;
      if (form.deadline) {
        // Convert YYYY-MM-DD date string to ISO 8601 with UTC (Z suffix)
        const [year, month, day] = form.deadline.split('-').map(Number);
        const deadlineDate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
        formattedDeadline = deadlineDate.toISOString();
      }

      const campaign = await api.createCampaign({
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        target_amount: form.target_amount,
        asset_type: form.asset_type,
        deadline: formattedDeadline,
        category: form.category || undefined,
        country: form.country?.trim() || undefined,
        min_contribution: form.min_contribution ? Number(form.min_contribution) : undefined,
        max_contribution: form.max_contribution ? Number(form.max_contribution) : undefined,
        max_per_user: form.max_per_user ? Number(form.max_per_user) : undefined,
        template_id: form.template_id || undefined,
        milestones: form.milestones.length
          ? form.milestones.map((milestone) => ({
              title: milestone.title.trim(),
              description: milestone.description.trim(),
              release_percentage: Number(milestone.release_percentage),
            }))
          : undefined,
        reward_tiers: form.reward_tiers.length
          ? form.reward_tiers.map((tier) => ({
              title: tier.title.trim(),
              description: tier.description.trim() || null,
              min_amount: Number(tier.min_amount),
              limit: tier.limit ? parseInt(tier.limit, 10) : null,
              estimated_delivery: tier.estimated_delivery || null,
              nft_enabled: Boolean(tier.nft_enabled),
              nft_metadata_url: tier.nft_metadata_url?.trim() || null,
              nft_artwork_url: tier.nft_artwork_url?.trim() || null,
            }))
          : undefined,
      });

      // Save any translations added during creation
      for (const [locale, trans] of Object.entries(translations)) {
        if (trans && trans.title && trans.title.trim()) {
          try {
            await api.saveCampaignTranslation(campaign.id, {
              locale,
              title: trans.title.trim(),
              description: trans.description?.trim() || null,
              milestone_titles: trans.milestone_titles || [],
            });
          } catch {
            // Non-fatal: translation can be added/edited in campaign settings
          }
        }
      }

      // The policy needs a campaign to attach to, so it is saved once the campaign
      // exists. A failure here leaves the campaign on the standard wallet rather
      // than presenting it as contract-backed when it is not.
      if (form.wallet_mode === 'contract') {
        try {
          await api.setTreasuryPolicy(campaign.id, form.treasury_policy);
        } catch (policyError) {
          setError(
            policyError.message ||
              'Campaign created, but the treasury policy could not be saved. Set it in campaign settings.'
          );
        }
      }

      // Save contributor requirements if any were set (#689)
      const hasRequirements =
        form.min_reputation_score > 0 || (form.required_attestations ?? []).length > 0;
      if (hasRequirements) {
        try {
          await api.setCampaignRequirements(campaign.id, {
            min_reputation_score: form.min_reputation_score ?? 0,
            required_attestations: form.required_attestations ?? [],
          });
        } catch (reqErr) {
          // Non-fatal: campaign exists, requirements can be set later in settings
          setError(
            reqErr.message ||
              'Campaign created, but contributor requirements could not be saved. Update them in campaign settings.'
          );
        }
      }

      clearDraft();
      if (draftId) {
        api.deleteCampaignDraft(draftId).catch(() => {});
        setDraftId(null);
      }

      let coverUploadError = '';
      if (coverImageFile) {
        try {
          await api.uploadCampaignCoverImage(campaign.id, coverImageFile);
        } catch (uploadError) {
          coverUploadError =
            uploadError.message || 'Campaign created, but cover image upload failed.';
        }
      }

      navigate(`/campaigns/${campaign.id}`, {
        state: { created: true, coverUploadError: coverUploadError || undefined },
      });
    } catch (err) {
      if (err.status === 401) {
        setError('Your session expired. Please log in again.');
        navigate('/login', { state: { from: '/campaigns/new' } });
      } else {
        setError(err.message || 'Could not create campaign. Try again.');
      }
      setLoading(false);
    }
  }
  if (!ready) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Restoring your session…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Redirecting to sign in…</p>
      </main>
    );
  }

  if (user?.role !== 'creator' && user?.role !== 'admin') {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Only creator or admin accounts can start campaigns.</p>
      </main>
    );
  }

  const kycRequired =
    user?.kyc_required_for_campaigns ??
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false';

  const verificationStatus = user?.verification_status || user?.kyc_status || 'unverified';
  const verificationTier = user?.verification_tier || 'none';
  const isVerified = verificationStatus === 'verified' || verificationStatus === 'approved';

  const TIER_LIMITS = { none: 0, basic: 5000, standard: 50000, enhanced: Infinity };
  const tierLimit = TIER_LIMITS[verificationTier] ?? 0;
  const goalAmount = Number(form.target_amount) || 0;
  const exceedsTierLimit =
    kycRequired && isVerified && goalAmount > tierLimit && tierLimit < Infinity;

  if (kycRequired && !isVerified) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem', paddingBottom: '3rem' }}>
        <KycPrompt onUserUpdate={updateUser} title="Complete Verification to Create Campaigns" />
        <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: 'var(--color-text-hint)' }}>
          Current verification status: <strong>{verificationStatus}</strong>.
        </p>
      </main>
    );
  }

  const milestoneTotal = milestonePercentTotal(form.milestones);
  return (
    <main className="container page-mid" style={{ paddingTop: '1.75rem', paddingBottom: '3rem' }}>
      <nav aria-label="Progress" style={{ marginBottom: '1.25rem' }}>
        <ol
          style={{
            listStyle: 'none',
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--color-text-hint)',
          }}
        >
          <li aria-current={step === 1 ? 'step' : undefined}>
            <span style={{ color: step === 1 ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
              {t('createCampaign.steps.goalAsset')}
            </span>
          </li>
          <li aria-hidden="true">→</li>
          <li aria-current={step === 2 ? 'step' : undefined}>
            <span style={{ color: step === 2 ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
              {t('createCampaign.steps.detailsLaunch')}
            </span>
          </li>
        </ol>
      </nav>

      <h1
        style={{
          fontSize: 'clamp(1.5rem, 4vw, 1.85rem)',
          fontWeight: 800,
          marginBottom: '0.35rem',
        }}
      >
        {t('createCampaign.title')}
      </h1>
      <p
        style={{
          color: 'var(--color-text-secondary)',
          marginBottom: '1.25rem',
          fontSize: '0.95rem',
          lineHeight: 1.55,
        }}
      >
        {t('createCampaign.subtitle')}
      </p>

      {showCreatorTips && (
        <OnboardingCallout title={t('createCampaign.tipsTitle')} onDismiss={dismissTips}>
          <ul>
            <li>{t('createCampaign.tip1')}</li>
            <li>{t('createCampaign.tip2')}</li>
            <li>{t('createCampaign.tip3')}</li>
          </ul>
        </OnboardingCallout>
      )}

      {pendingDraft && (
        <div className="alert alert--info" style={{ marginBottom: '1.25rem' }} role="status">
          <p>
            You have an unsaved draft from{' '}
            <strong>{new Date(pendingDraft.saved_at).toLocaleString()}</strong>.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.65rem' }}>
            <button type="button" className="btn-primary" onClick={restoreDraft}>
              Restore draft
            </button>
            <button type="button" className="btn-secondary" onClick={discardDraft}>
              Discard draft
            </button>
          </div>
        </div>
      )}

      {!pendingDraft && (draftSaving || draftSavedAt) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.65rem',
            flexWrap: 'wrap',
            marginBottom: '1rem',
            fontSize: '0.8rem',
            color: 'var(--color-text-hint)',
          }}
          role="status"
          aria-live="polite"
        >
          <span>
            {draftSaving
              ? 'Saving draft…'
              : `Draft saved ${new Date(draftSavedAt).toLocaleTimeString()}`}
          </span>
          {draftSavedAt && (
            <button
              type="button"
              onClick={discardCurrentDraft}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--color-accent)',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: '0.8rem',
              }}
            >
              Discard draft
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {location.state?.prefill && (
          <div className="alert alert--info" style={{ marginBottom: '1.25rem' }}>
            Pre-filled from an existing campaign. Review and adjust before launching.
          </div>
        )}
        {step === 1 && (
          <CreateCampaignStepGoal
            t={t}
            form={form}
            templates={templates}
            kycRequired={kycRequired}
            isVerified={isVerified}
            verificationTier={verificationTier}
            tierLimit={tierLimit}
            exceedsTierLimit={exceedsTierLimit}
            setField={setField}
            applyTemplate={applyTemplate}
            selectAsset={selectAsset}
            updateTreasuryPolicy={updateTreasuryPolicy}
            setForm={setForm}
            error={error}
            onContinue={() => {
              if (validateStep1()) setStep(2);
            }}
          />
        )}

        {step === 2 && (
          <CreateCampaignStepDetails
            t={t}
            form={form}
            coverImageFile={coverImageFile}
            coverImagePreview={coverImagePreview}
            isDragOverCover={isDragOverCover}
            translations={translations}
            activeTranslationLocale={activeTranslationLocale}
            today={today}
            setField={setField}
            setDescription={setDescription}
            setTranslations={setTranslations}
            setActiveTranslationLocale={setActiveTranslationLocale}
            handleCoverImageChange={handleCoverImageChange}
            handleCoverImageDrop={handleCoverImageDrop}
            setIsDragOverCover={setIsDragOverCover}
            setForm={setForm}
            error={error}
            onContinue={() => {
              if (validateStep2()) setStep(3);
            }}
            onBack={() => {
              setError('');
              setStep(1);
            }}
          />
        )}

        {step === 3 && (
          <CreateCampaignStepMilestones
            t={t}
            form={form}
            milestoneTotal={milestoneTotal}
            today={today}
            error={error}
            duplicateWarning={duplicateWarning}
            loading={loading}
            setForm={setForm}
            setMilestoneField={setMilestoneField}
            addMilestone={addMilestone}
            removeMilestone={removeMilestone}
            setTierField={setTierField}
            addTier={addTier}
            removeTier={removeTier}
            onBack={() => {
              setError('');
              setStep(2);
            }}
          />
        )}
      </form>

      <p style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
        <Link to="/discover" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          {t('createCampaign.backToCampaigns')}
        </Link>
      </p>
    </main>
  );
}
