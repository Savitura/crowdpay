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

const CATEGORIES = [
  { value: 'technology', label: 'Technology' },
  { value: 'community', label: 'Community' },
  { value: 'arts', label: 'Arts & Culture' },
  { value: 'education', label: 'Education' },
  { value: 'environment', label: 'Environment' },
  { value: 'health', label: 'Health' },
  { value: 'business', label: 'Business' },
  { value: 'open_source', label: 'Open Source' },
  { value: 'other', label: 'Other' },
];
export default function CreateCampaignStepGoal({
  t,
  form,
  templates,
  kycRequired,
  isVerified,
  verificationTier,
  tierLimit,
  exceedsTierLimit,
  setField,
  applyTemplate,
  selectAsset,
  updateTreasuryPolicy,
  setForm,
  error,
  onContinue,
}) {
  return (
    <>
      <>
        {templates.length > 0 && (
          <div className="form-stack" style={{ marginBottom: '1rem' }}>
            <label className="label-strong" htmlFor="cc-template">
              Start with a template (Optional)
            </label>
            <select
              id="cc-template"
              value={form.template_id}
              onChange={(event) => applyTemplate(event.target.value)}
            >
              <option value="">Start from scratch</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} — {template.description}
                </option>
              ))}
            </select>
            {form.template_id && (
              <small style={{ color: 'var(--color-text-hint)' }}>
                The template filled in your campaign details. You can customize every field.
              </small>
            )}
          </div>
        )}
        <div className="form-stack">
          <label className="label-strong" htmlFor="cc-title">
            {t('createCampaign.campaignTitle')}
          </label>
          <input
            id="cc-title"
            value={form.title}
            onChange={setField('title')}
            placeholder={t('createCampaign.campaignTitlePlaceholder')}
            required
            aria-required="true"
            autoComplete="off"
          />
        </div>

        <div className="form-stack" style={{ marginTop: '1rem' }}>
          <label className="label-strong" htmlFor="cc-target">
            {t('createCampaign.fundraisingGoal')}
          </label>
          <input
            id="cc-target"
            type="number"
            inputMode="decimal"
            min="0.0000001"
            step="any"
            value={form.target_amount}
            onChange={setField('target_amount')}
            placeholder={t('createCampaign.targetAmountPlaceholder')}
            required
            aria-required="true"
          />
          {kycRequired && isVerified && verificationTier !== 'enhanced' && (
            <small style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem' }}>
              Your {verificationTier} tier allows campaign goals up to ${tierLimit.toLocaleString()}
              .{verificationTier === 'basic' && ' Upgrade to Standard for up to $50,000.'}
              {verificationTier === 'standard' && ' Upgrade to Enhanced for unlimited goals.'}
            </small>
          )}
          {exceedsTierLimit && (
            <div
              className="alert alert--warning"
              style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}
            >
              <strong>
                Goal exceeds your {verificationTier} tier limit of ${tierLimit.toLocaleString()}.
              </strong>
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.82rem' }}>
                {verificationTier === 'basic' &&
                  'Upgrade to Standard verification (ID + address) to run campaigns up to $50,000.'}
                {verificationTier === 'standard' &&
                  'Upgrade to Enhanced verification (ID + address + liveness) for unlimited campaign goals.'}
              </p>
            </div>
          )}
        </div>

        <div className="form-stack" style={{ marginTop: '1rem' }}>
          <label className="label-strong" htmlFor="cc-category">
            {t('createCampaign.contributionLimits')}
          </label>
          <input
            id="cc-category"
            value={form.category}
            onChange={setField('category')}
            placeholder={t('createCampaign.categoryPlaceholder')}
            autoComplete="off"
          />
        </div>

        <div
          style={{
            marginTop: '1.25rem',
            border: '1px dashed var(--color-border)',
            padding: '1rem',
            borderRadius: '8px',
          }}
        >
          <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            {t('createCampaign.contributionLimits')}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div className="form-stack">
              <label className="label-strong" htmlFor="cc-min-contrib">
                {t('createCampaign.minContribution')}
              </label>
              <input
                id="cc-min-contrib"
                type="number"
                inputMode="decimal"
                min="0.0000001"
                step="any"
                value={form.min_contribution}
                onChange={setField('min_contribution')}
                placeholder={t('createCampaign.minContributionPlaceholder')}
              />
            </div>
            <div className="form-stack">
              <label className="label-strong" htmlFor="cc-max-contrib">
                {t('createCampaign.maxContribution')}
              </label>
              <input
                id="cc-max-contrib"
                type="number"
                inputMode="decimal"
                min="0.0000001"
                step="any"
                value={form.max_contribution}
                onChange={setField('max_contribution')}
                placeholder={t('createCampaign.maxContributionPlaceholder')}
              />
            </div>
          </div>
        </div>

        <fieldset style={{ border: 'none', margin: '1.25rem 0 0', padding: 0 }}>
          <legend className="label-strong" style={{ marginBottom: '0.5rem' }}>
            {t('createCampaign.settlementAsset')}
          </legend>
          <p
            style={{
              fontSize: '0.8rem',
              color: 'var(--color-text-hint)',
              marginBottom: '0.65rem',
            }}
          >
            {t('createCampaign.settlementAssetHelp')}
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

        <fieldset className="form-stack" style={{ marginTop: '1rem' }}>
          <legend className="label-strong">Treasury mode</legend>
          <p style={{ color: 'var(--color-text-muted)', marginBottom: '0.65rem' }}>
            Standard uses the two-of-two multisig wallet. Contract holds the funds in a Soroban
            treasury that enforces your spending rules on-chain — the rules cannot be changed once
            the campaign is created.
          </p>
          <div role="radiogroup" aria-label="Treasury mode">
            <label>
              <input
                type="radio"
                name="wallet_mode"
                value="standard"
                checked={form.wallet_mode === 'standard'}
                onChange={() => setForm((f) => ({ ...f, wallet_mode: 'standard' }))}
              />
              Standard multisig
            </label>
            <label>
              <input
                type="radio"
                name="wallet_mode"
                value="contract"
                checked={form.wallet_mode === 'contract'}
                onChange={() => setForm((f) => ({ ...f, wallet_mode: 'contract' }))}
              />
              Soroban contract treasury
            </label>
          </div>

          {form.wallet_mode === 'contract' && (
            <div className="form-stack" aria-label="Treasury policy">
              <label htmlFor="cc-min-hold">
                Minimum hold period: <strong>{form.treasury_policy.minHoldDays} days</strong> after
                the deadline
              </label>
              <input
                id="cc-min-hold"
                type="range"
                min="0"
                max="90"
                value={form.treasury_policy.minHoldDays}
                onChange={(e) => updateTreasuryPolicy('minHoldDays', Number(e.target.value))}
              />

              <label htmlFor="cc-max-pct">
                Maximum single withdrawal:{' '}
                <strong>{form.treasury_policy.maxSingleWithdrawalPct}%</strong> of the balance
              </label>
              <input
                id="cc-max-pct"
                type="range"
                min="10"
                max="100"
                value={form.treasury_policy.maxSingleWithdrawalPct}
                onChange={(e) =>
                  updateTreasuryPolicy('maxSingleWithdrawalPct', Number(e.target.value))
                }
              />

              <label htmlFor="cc-cooldown">
                Cooldown between withdrawals:{' '}
                <strong>{form.treasury_policy.withdrawalCooldownHours} hours</strong>
              </label>
              <input
                id="cc-cooldown"
                type="range"
                min="0"
                max="168"
                value={form.treasury_policy.withdrawalCooldownHours}
                onChange={(e) =>
                  updateTreasuryPolicy('withdrawalCooldownHours', Number(e.target.value))
                }
              />

              <label htmlFor="cc-auditor-above">Auditor required above ({form.asset_type})</label>
              <input
                id="cc-auditor-above"
                type="text"
                inputMode="decimal"
                value={form.treasury_policy.requireAuditorForAbove}
                onChange={(e) => updateTreasuryPolicy('requireAuditorForAbove', e.target.value)}
              />

              <label htmlFor="cc-auto-refund">
                <input
                  id="cc-auto-refund"
                  type="checkbox"
                  checked={form.treasury_policy.autoRefundOnMiss}
                  onChange={(e) => updateTreasuryPolicy('autoRefundOnMiss', e.target.checked)}
                />
                Refund contributors automatically if the goal is missed
              </label>
              <small style={{ color: 'var(--color-text-muted)' }}>
                Anyone can trigger the refund once the deadline passes, so contributors are not
                dependent on you or CrowdPay acting.
              </small>
            </div>
          )}
        </fieldset>

        <div className="form-stack" style={{ marginTop: '1rem' }}>
          <label className="label-strong" htmlFor="cc-category">
            Category{' '}
            <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>(optional)</span>
          </label>
          <select id="cc-category" value={form.category} onChange={setField('category')}>
            <option value="">Select a category</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group" style={{ marginTop: '1rem' }}>
          <label className="label-strong" htmlFor="cc-country">
            Location{' '}
            <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>(optional)</span>
          </label>
          <input
            id="cc-country"
            type="text"
            value={form.country}
            onChange={setField('country')}
            placeholder={t('createCampaign.countryPlaceholder')}
            maxLength={80}
          />
        </div>

        {error && (
          <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          className="btn-primary"
          style={{ width: '100%', marginTop: '1.25rem' }}
          onClick={onContinue}
        >
          {t('createCampaign.continueToDetails')}
        </button>
      </>
    </>
  );
}
