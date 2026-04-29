import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import SimpleMDE from 'react-simplemde-editor';
import 'easymde/dist/easymde.min.css';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import OnboardingCallout from '../components/OnboardingCallout';
import KycPrompt from '../components/KycPrompt';
import {
  isCreatorOnboardingVisible,
  dismissCreatorOnboarding,
} from '../lib/onboarding';

const ASSETS = [
  {
    value: 'USDC',
    label: 'USDC',
    hint: 'Stable dollar value on Stellar. Best when backers think in USD.',
  },
  {
    value: 'XLM',
    label: 'XLM',
    hint: 'Native Stellar asset. Simple for contributors who already hold XLM.',
  },
];
function emptyMilestone() {
  return { title: '', description: '', release_percentage: '' };
}

function milestonePercentTotal(milestones) {
  return milestones.reduce((sum, milestone) => sum + (Number(milestone.release_percentage) || 0), 0);
}

export default function CreateCampaign() {
  const { token, user, ready, updateUser } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    deadline: '',
    milestones: [],
    min_contribution: '',
    max_contribution: '',
    show_backer_amounts: true,
  });
  const [coverImageFile, setCoverImageFile] = useState(null);
  const [coverImagePreview, setCoverImagePreview] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCreatorTips, setShowCreatorTips] = useState(isCreatorOnboardingVisible);

  useEffect(() => {
    if (ready && !token) {
      navigate('/login', { replace: true, state: { from: '/campaigns/new' } });
    }
  }, [ready, token, navigate]);

  useEffect(() => {
    if (!token) return;
    api.getMe(token).then(updateUser).catch(() => {});
  }, [token, updateUser]);

  function setField(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function setDescription(value) {
    setForm((f) => ({ ...f, description: value }));
  }

  function selectAsset(value) {
    setForm((f) => ({ ...f, asset_type: value }));
  }

  function handleCoverImageChange(e) {
    const file = e.target.files?.[0] || null;
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
      if (f.milestones.length >= 10) return f;
      return { ...f, milestones: [...f.milestones, emptyMilestone()] };
    });
  }

  function removeMilestone(index) {
    setForm((f) => ({
      ...f,
      milestones: f.milestones.filter((_, milestoneIndex) => milestoneIndex !== index),
    }));
  }

  function validateStep1() {
    if (!form.title.trim()) {
      setError('Please enter a campaign title.');
      return false;
    }
    if (!form.target_amount || Number(form.target_amount) <= 0) {
      setError('Enter a fundraising goal greater than zero.');
      return false;
    }
    if (form.min_contribution && Number(form.min_contribution) <= 0) {
      setError('Minimum contribution must be greater than zero.');
      return false;
    }
    if (form.max_contribution) {
      if (Number(form.max_contribution) <= 0) {
        setError('Maximum contribution must be greater than zero.');
        return false;
      }
      if (form.min_contribution && Number(form.max_contribution) <= Number(form.min_contribution)) {
        setError('Maximum contribution must be greater than minimum contribution.');
        return false;
      }
      if (form.target_amount && Number(form.max_contribution) > Number(form.target_amount)) {
        setError('Maximum contribution cannot exceed the target amount.');
        return false;
      }
    }
    setError('');
    return true;
  }

  function validateMilestones() {
    if (form.milestones.length === 0) {
      setError('');
      return true;
    }
    if (form.milestones.length > 10) {
      setError('Campaigns can define at most 10 milestones.');
      return false;
    }

    for (let index = 0; index < form.milestones.length; index += 1) {
      const milestone = form.milestones[index];
      if (!milestone.title.trim()) {
        setError(`Milestone ${index + 1} needs a title.`);
        return false;
      }
      if (!milestone.description.trim()) {
        setError(`Milestone ${index + 1} needs a description.`);
        return false;
      }
      if (!milestone.release_percentage || Number(milestone.release_percentage) <= 0) {
        setError(`Milestone ${index + 1} needs a release percentage greater than zero.`);
        return false;
      }
    }

    const total = milestonePercentTotal(form.milestones);
    if (Math.abs(total - 100) > 0.0001) {
      setError('Milestone percentages must sum to exactly 100%.');
      return false;
    }

    setError('');
    return true;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validateStep1() || !validateMilestones()) return;
    setLoading(true);
    setError('');
    try {
      const campaign = await api.createCampaign(
        {
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          target_amount: form.target_amount,
          asset_type: form.asset_type,
          deadline: form.deadline || undefined,
          min_contribution: form.min_contribution ? Number(form.min_contribution) : undefined,
          max_contribution: form.max_contribution ? Number(form.max_contribution) : undefined,
          milestones: form.milestones.length
            ? form.milestones.map((milestone) => ({
                title: milestone.title.trim(),
                description: milestone.description.trim(),
                release_percentage: Number(milestone.release_percentage),
              }))
            : undefined,
        },
        token
      );

      let coverUploadError = '';
      if (coverImageFile) {
        try {
          await api.uploadCampaignCoverImage(campaign.id, coverImageFile, token);
        } catch (uploadError) {
          coverUploadError = uploadError.message || 'Campaign created, but cover image upload failed.';
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

  if (!token) {
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

  const kycRequired = user?.kyc_required_for_campaigns ?? (
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false'
  );

  if (kycRequired && user?.kyc_status !== 'verified') {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem', paddingBottom: '3rem' }}>
        <KycPrompt token={token} onUserUpdate={updateUser} title="Verify your identity first" />
        <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#666' }}>
          Current verification status: <strong>{user?.kyc_status || 'unverified'}</strong>.
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
            color: '#666',
          }}
        >
          <li>
            <span style={{ color: step === 1 ? '#7c3aed' : '#999' }}>1. Goal & asset</span>
          </li>
          <li aria-hidden="true">→</li>
          <li>
            <span style={{ color: step === 2 ? '#7c3aed' : '#999' }}>2. Details</span>
          </li>
          <li aria-hidden="true">→</li>
          <li>
            <span style={{ color: step === 3 ? '#7c3aed' : '#999' }}>3. Milestones & launch</span>
          </li>
        </ol>
      </nav>

      <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 1.85rem)', fontWeight: 800, marginBottom: '0.35rem' }}>
        Start a campaign
      </h1>
      <p style={{ color: '#555', marginBottom: '1.25rem', fontSize: '0.95rem', lineHeight: 1.55 }}>
        We create a dedicated Stellar wallet for your campaign. You choose the settlement asset and, if you want
        staged releases, define the milestone plan that unlocks funds over time.
      </p>

      {showCreatorTips && (
        <OnboardingCallout title="First time creating a campaign?" onDismiss={dismissTips}>
          <ul>
            <li>Pick the asset that matches how you think about your goal (USD-like vs XLM).</li>
            <li>Milestones are optional, but they make releases auditable and give backers more confidence.</li>
            <li>Withdrawals need both you and CrowdPay to sign — milestone campaigns use that flow automatically.</li>
          </ul>
        </OnboardingCallout>
      )}

      <form onSubmit={handleSubmit}>
        {step === 1 && (
          <>
            <div className="form-stack">
              <label className="label-strong" htmlFor="cc-title">
                Campaign title
              </label>
              <input
                id="cc-title"
                value={form.title}
                onChange={setField('title')}
                placeholder="e.g. Community garden rebuild"
                required
                autoComplete="off"
              />
            </div>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-target">
                Fundraising goal
              </label>
              <input
                id="cc-target"
                type="number"
                inputMode="decimal"
                min="0.0000001"
                step="any"
                value={form.target_amount}
                onChange={setField('target_amount')}
                placeholder="0.00"
                required
              />
            </div>

            <div style={{ marginTop: '1.25rem', border: '1px dashed #ccc', padding: '1rem', borderRadius: '8px' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>Contribution limits (Optional)</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="form-stack">
                  <label className="label-strong" htmlFor="cc-min-contrib">Min contribution</label>
                  <input
                    id="cc-min-contrib"
                    type="number"
                    inputMode="decimal"
                    min="0.0000001"
                    step="any"
                    value={form.min_contribution}
                    onChange={setField('min_contribution')}
                    placeholder="e.g. 5"
                  />
                </div>
                <div className="form-stack">
                  <label className="label-strong" htmlFor="cc-max-contrib">Max contribution</label>
                  <input
                    id="cc-max-contrib"
                    type="number"
                    inputMode="decimal"
                    min="0.0000001"
                    step="any"
                    value={form.max_contribution}
                    onChange={setField('max_contribution')}
                    placeholder="e.g. 500"
                  />
                </div>
              </div>
            </div>

            <fieldset style={{ border: 'none', margin: '1.25rem 0 0', padding: 0 }}>
              <legend className="label-strong" style={{ marginBottom: '0.5rem' }}>
                Settlement asset
              </legend>
              <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.65rem' }}>
                Progress and payouts use this asset. Contributors may use a different asset if Stellar can convert it.
              </p>
              <div className="asset-picker" role="radiogroup" aria-label="Settlement asset">
                {ASSETS.map((a) => (
                  <label
                    key={a.value}
                    className={`asset-picker__option${form.asset_type === a.value ? ' asset-picker__option--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="asset_type"
                      value={a.value}
                      checked={form.asset_type === a.value}
                      onChange={() => selectAsset(a.value)}
                    />
                    <div className="asset-picker__code">{a.label}</div>
                    <div className="asset-picker__hint">{a.hint}</div>
                  </label>
                ))}
              </div>
            </fieldset>

            {error && (
              <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%', marginTop: '1.25rem' }}
              onClick={() => {
                if (validateStep1()) setStep(2);
              }}
            >
              Continue to details
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div className="form-stack">
              <label className="label-strong" htmlFor="cc-desc">
                Description <span style={{ fontWeight: 500, color: '#888' }}>(optional)</span>
              </label>
              <SimpleMDE
                id="cc-desc"
                value={form.description}
                onChange={setDescription}
                options={{ spellChecker: false, placeholder: 'Tell backers what the funds will be used for and what success looks like.' }}
              />
            </div>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-cover">
                Cover image <span style={{ fontWeight: 500, color: '#888' }}>(optional)</span>
              </label>
              <input
                id="cc-cover"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleCoverImageChange}
              />
              {coverImagePreview && (
                <img
                  src={coverImagePreview}
                  alt="Cover preview"
                  style={{ marginTop: '0.75rem', width: '100%', borderRadius: '12px', maxHeight: '220px', objectFit: 'cover' }}
                />
              )}
            </div>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-deadline">
                Deadline <span style={{ fontWeight: 500, color: '#888' }}>(optional)</span>
              </label>
              <input id="cc-deadline" type="date" value={form.deadline} onChange={setField('deadline')} />
            </div>

            <div className="form-stack" style={{ marginTop: '1.25rem', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
              <input
                id="cc-show-backers"
                type="checkbox"
                style={{ width: 'auto', margin: 0 }}
                checked={form.show_backer_amounts}
                onChange={(e) => setForm((f) => ({ ...f, show_backer_amounts: e.target.checked }))}
              />
              <label htmlFor="cc-show-backers" style={{ fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}>
                Show contribution amounts on backer wall
              </label>
            </div>
            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.35rem' }}>
              If unchecked, backers will be listed but their individual amounts will be hidden from the public.
            </p>

            <div className="alert alert--info" style={{ marginTop: '1.25rem' }} role="status">
              <strong>Summary:</strong> Goal of {form.target_amount || '—'} {form.asset_type}
              {form.min_contribution && ` (Min: ${form.min_contribution} ${form.asset_type})`}
              {form.max_contribution && ` (Max: ${form.max_contribution} ${form.asset_type})`} — “{form.title || 'Untitled'}”.
              A multisig campaign wallet will be created when you launch.
            </div>

            {error && (
              <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '1.25rem' }}>
              <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={() => setStep(3)}>
                Continue to milestones
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%' }}
                onClick={() => {
                  setError('');
                  setStep(1);
                }}
              >
                Back
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="campaign-card" style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                <strong>Milestone plan</strong>
                <span style={{ fontSize: '0.85rem', color: milestoneTotal === 100 || form.milestones.length === 0 ? '#166534' : '#92400e' }}>
                  Total: {milestoneTotal.toLocaleString()}%
                </span>
              </div>
              <p style={{ color: '#555', fontSize: '0.88rem', lineHeight: 1.5 }}>
                Milestones are optional. If you add them, define between 1 and 10 release checkpoints and make sure the
                percentages sum to exactly 100.
              </p>
            </div>

            {form.milestones.length === 0 ? (
              <div className="alert alert--info" style={{ marginBottom: '1rem' }}>
                No milestones added yet. Legacy campaigns can still use the existing single-withdrawal flow.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '0.85rem' }}>
                {form.milestones.map((milestone, index) => (
                  <div key={index} className="campaign-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <strong>Milestone {index + 1}</strong>
                      <button type="button" className="btn-secondary" onClick={() => removeMilestone(index)} style={{ fontSize: '0.8rem' }}>
                        Remove
                      </button>
                    </div>
                    <div className="form-stack">
                      <label className="label-strong">Title</label>
                      <input
                        value={milestone.title}
                        onChange={(e) => setMilestoneField(index, 'title', e.target.value)}
                        placeholder="e.g. Deliver prototype"
                      />
                    </div>
                    <div className="form-stack" style={{ marginTop: '0.75rem' }}>
                      <label className="label-strong">Description</label>
                      <textarea
                        value={milestone.description}
                        onChange={(e) => setMilestoneField(index, 'description', e.target.value)}
                        rows={3}
                        placeholder="Explain what contributors should expect before this release unlocks."
                      />
                    </div>
                    <div className="form-stack" style={{ marginTop: '0.75rem' }}>
                      <label className="label-strong">Release percentage</label>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0.01"
                        step="0.01"
                        value={milestone.release_percentage}
                        onChange={(e) => setMilestoneField(index, 'release_percentage', e.target.value)}
                        placeholder="25"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {form.milestones.length < 10 && (
              <button type="button" className="btn-secondary" style={{ width: '100%', marginTop: '1rem' }} onClick={addMilestone}>
                + Add milestone
              </button>
            )}

            <div className="alert alert--info" style={{ marginTop: '1.25rem' }} role="status">
              <strong>Launch summary:</strong> {form.title || 'Untitled'} with a goal of {form.target_amount || '—'} {form.asset_type}
              {form.min_contribution && ` (Min: ${form.min_contribution} ${form.asset_type})`}
              {form.max_contribution && ` (Max: ${form.max_contribution} ${form.asset_type})`}
              {form.milestones.length ? ` and ${form.milestones.length} milestone release${form.milestones.length > 1 ? 's' : ''}.` : ' and no milestone plan.'}
            </div>

            {error && (
              <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '1.25rem' }}>
              <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%' }}>
                {loading ? 'Creating wallet…' : 'Launch campaign'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%' }}
                disabled={loading}
                onClick={() => {
                  setError('');
                  setStep(2);
                }}
              >
                Back
              </button>
            </div>
          </>
        )}
      </form>

      <p style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: '#777' }}>
        <Link to="/" style={{ color: '#7c3aed', fontWeight: 600 }}>
          ← Back to campaigns
        </Link>
      </p>
    </main>
  );
}
