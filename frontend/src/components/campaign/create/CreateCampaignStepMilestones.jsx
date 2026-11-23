export default function CreateCampaignStepMilestones({
  t,
  form,
  milestoneTotal,
  today,
  error,
  duplicateWarning,
  loading,
  setForm,
  setMilestoneField,
  addMilestone,
  removeMilestone,
  setTierField,
  addTier,
  removeTier,
  onBack,
}) {
  return (
    <>
      <>
        <div className="campaign-card" style={{ marginBottom: '1rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '0.75rem',
              flexWrap: 'wrap',
              marginBottom: '0.5rem',
            }}
          >
            <strong>{t('createCampaign.milestonePlan')}</strong>
            <span
              style={{
                fontSize: '0.85rem',
                color:
                  milestoneTotal === 100 || form.milestones.length === 0
                    ? 'var(--color-success-text)'
                    : 'var(--color-warning-text)',
              }}
            >
              {t('createCampaign.milestoneTotal', { count: milestoneTotal.toLocaleString() })}
            </span>
          </div>
          <p
            style={{
              color: 'var(--color-text-secondary)',
              fontSize: '0.88rem',
              lineHeight: 1.5,
            }}
          >
            {t('createCampaign.milestoneHelp')}
          </p>
        </div>

        {form.milestones.length === 0 ? (
          <div className="alert alert--info" style={{ marginBottom: '1rem' }}>
            {t('createCampaign.noMilestones')}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '0.85rem' }}>
            {form.milestones.map((milestone, index) => (
              <div key={index} className="campaign-card">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <strong>{t('createCampaign.milestone', { count: index + 1 })}</strong>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => removeMilestone(index)}
                    style={{ fontSize: '0.8rem' }}
                  >
                    Remove
                  </button>
                </div>
                <div className="form-stack">
                  <label className="label-strong">{t('createCampaign.milestoneTitle')}</label>
                  <input
                    value={milestone.title}
                    onChange={(e) => setMilestoneField(index, 'title', e.target.value)}
                    placeholder={t('createCampaign.milestoneTitlePlaceholder')}
                  />
                </div>
                <div className="form-stack" style={{ marginTop: '0.75rem' }}>
                  <label className="label-strong">{t('createCampaign.milestoneDescription')}</label>
                  <textarea
                    value={milestone.description}
                    onChange={(e) => setMilestoneField(index, 'description', e.target.value)}
                    rows={3}
                    placeholder={t('createCampaign.milestoneDescriptionPlaceholder')}
                  />
                </div>
                <div className="form-stack" style={{ marginTop: '0.75rem' }}>
                  <label className="label-strong">{t('createCampaign.milestoneRelease')}</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="0.01"
                    value={milestone.release_percentage}
                    onChange={(e) => setMilestoneField(index, 'release_percentage', e.target.value)}
                    placeholder={t('createCampaign.milestoneReleasePlaceholder')}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {form.milestones.length < 5 && (
          <button
            type="button"
            className="btn-secondary"
            style={{ width: '100%', marginTop: '1rem' }}
            onClick={addMilestone}
          >
            {t('createCampaign.addMilestone')}
          </button>
        )}

        <div className="campaign-card" style={{ marginTop: '1.75rem', marginBottom: '1rem' }}>
          <strong>
            {t('createCampaign.rewardTiers')}{' '}
            <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
              {t('createCampaign.rewardTiersOptional')}
            </span>
          </strong>
          <p
            style={{
              color: 'var(--color-text-secondary)',
              fontSize: '0.88rem',
              lineHeight: 1.5,
              marginTop: '0.35rem',
            }}
          >
            {t('createCampaign.rewardTiersHelp')}
          </p>
        </div>

        {form.reward_tiers.length === 0 ? (
          <div className="alert alert--info" style={{ marginBottom: '1rem' }}>
            {t('createCampaign.noRewardTiers')}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '0.85rem' }}>
            {form.reward_tiers.map((tier, index) => (
              <div key={index} className="campaign-card">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <strong>{t('createCampaign.tierLabel', { count: index + 1 })}</strong>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => removeTier(index)}
                    style={{ fontSize: '0.8rem' }}
                  >
                    {t('createCampaign.removeTier')}
                  </button>
                </div>
                <div className="form-stack">
                  <label className="label-strong">{t('createCampaign.tierTitle')}</label>
                  <input
                    value={tier.title}
                    onChange={(e) => setTierField(index, 'title', e.target.value)}
                    placeholder={t('createCampaign.tierTitlePlaceholder')}
                  />
                </div>
                <div className="form-stack" style={{ marginTop: '0.75rem' }}>
                  <label className="label-strong">
                    {t('createCampaign.tierDescription')}{' '}
                    <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                      {t('createCampaign.tierDescriptionOptional')}
                    </span>
                  </label>
                  <textarea
                    value={tier.description}
                    onChange={(e) => setTierField(index, 'description', e.target.value)}
                    rows={2}
                    placeholder={t('createCampaign.tierDescriptionPlaceholder')}
                  />
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '0.75rem',
                    marginTop: '0.75rem',
                  }}
                >
                  <div className="form-stack">
                    <label className="label-strong">
                      {t('createCampaign.tierMinAmount', { asset: form.asset_type })}
                    </label>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0.0000001"
                      step="any"
                      value={tier.min_amount}
                      onChange={(e) => setTierField(index, 'min_amount', e.target.value)}
                      placeholder={t('createCampaign.tierMinAmountPlaceholder')}
                    />
                  </div>
                  <div className="form-stack">
                    <label className="label-strong">
                      {t('createCampaign.tierLimit')}{' '}
                      <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                        {t('createCampaign.tierLimitOptional')}
                      </span>
                    </label>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      step="1"
                      value={tier.limit}
                      onChange={(e) => setTierField(index, 'limit', e.target.value)}
                      placeholder={t('createCampaign.tierLimitPlaceholder')}
                    />
                  </div>
                </div>
                <div className="form-stack" style={{ marginTop: '0.75rem' }}>
                  <label className="label-strong">
                    {t('createCampaign.tierEstimatedDelivery')}{' '}
                    <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                      {t('createCampaign.tierEstimatedDeliveryOptional')}
                    </span>
                  </label>
                  <input
                    type="date"
                    min={today}
                    value={tier.estimated_delivery}
                    onChange={(e) => setTierField(index, 'estimated_delivery', e.target.value)}
                  />
                </div>
                <div className="campaign-card" style={{ marginTop: '0.75rem', padding: '0.85rem' }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      fontWeight: 700,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(tier.nft_enabled)}
                      onChange={(e) => setTierField(index, 'nft_enabled', e.target.checked)}
                    />
                    {t('createCampaign.tierNftEnabled')}
                  </label>
                  <p
                    style={{
                      marginTop: '0.45rem',
                      marginBottom: '0.65rem',
                      fontSize: '0.84rem',
                      color: 'var(--color-text-secondary)',
                    }}
                  >
                    {t('createCampaign.tierNftHelp')}
                  </p>
                  {Boolean(tier.nft_enabled) && (
                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                      <div className="form-stack">
                        <label className="label-strong">
                          {t('createCampaign.tierMetadataUrl')}{' '}
                          <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                            {t('createCampaign.tierMetadataUrlOptional')}
                          </span>
                        </label>
                        <input
                          value={tier.nft_metadata_url || ''}
                          onChange={(e) => setTierField(index, 'nft_metadata_url', e.target.value)}
                          placeholder={t('createCampaign.tierMetadataUrlPlaceholder')}
                        />
                      </div>
                      <div className="form-stack">
                        <label className="label-strong">
                          {t('createCampaign.tierArtworkUrl')}{' '}
                          <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                            {t('createCampaign.tierArtworkUrlOptional')}
                          </span>
                        </label>
                        <input
                          value={tier.nft_artwork_url || ''}
                          onChange={(e) => setTierField(index, 'nft_artwork_url', e.target.value)}
                          placeholder={t('createCampaign.tierArtworkUrlPlaceholder')}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {form.reward_tiers.length < 10 && (
          <button
            type="button"
            className="btn-secondary"
            style={{ width: '100%', marginTop: '1rem' }}
            onClick={addTier}
          >
            {t('createCampaign.addRewardTier')}
          </button>
        )}

        <div className="alert alert--info" style={{ marginTop: '1.25rem' }} role="status">
          <strong>{t('createCampaign.launchSummary')}</strong> {form.title || 'Untitled'} with a
          goal of {form.target_amount || '—'} {form.asset_type}
          {form.min_contribution && ` (Min: ${form.min_contribution} ${form.asset_type})`}
          {form.max_contribution && ` (Max: ${form.max_contribution} ${form.asset_type})`}
          {form.max_per_user && ` (Cap: ${form.max_per_user} ${form.asset_type})`}
          {form.milestones.length
            ? ` and ${form.milestones.length} milestone release${form.milestones.length > 1 ? 's' : ''}.`
            : ' and no milestone plan.'}
        </div>

        {/* ── Contributor Requirements (#689) ─────────────────────────── */}
        <div className="campaign-card" style={{ marginTop: '1.25rem' }}>
          <strong style={{ display: 'block', marginBottom: '0.5rem' }}>
            Contributor Requirements
          </strong>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-secondary)',
              marginBottom: '1rem',
            }}
          >
            Optionally restrict who can contribute to this campaign. Contributors who don&apos;t
            meet these requirements will be blocked.
          </p>

          {/* Minimum reputation score */}
          <label className="label-strong" htmlFor="min_reputation_score">
            Minimum reputation score (0 = no minimum)
          </label>
          <input
            id="min_reputation_score"
            type="range"
            min="0"
            max="500"
            step="10"
            value={form.min_reputation_score ?? 0}
            onChange={(e) =>
              setForm((f) => ({ ...f, min_reputation_score: Number(e.target.value) }))
            }
            style={{ width: '100%', margin: '0.5rem 0' }}
          />
          <div
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-secondary)',
              marginBottom: '1rem',
            }}
          >
            Selected: <strong>{form.min_reputation_score ?? 0}</strong>
          </div>

          {/* Required attestations */}
          <label className="label-strong" style={{ display: 'block', marginBottom: '0.5rem' }}>
            Required KYC attestations
          </label>
          {[
            { value: 'kyc_basic', label: 'KYC Basic' },
            { value: 'kyc_standard', label: 'KYC Standard' },
            { value: 'kyc_enhanced', label: 'KYC Enhanced' },
          ].map(({ value, label }) => {
            const current = form.required_attestations ?? [];
            const checked = current.includes(value);
            return (
              <label
                key={value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '0.4rem',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setForm((f) => ({
                      ...f,
                      required_attestations: checked
                        ? (f.required_attestations ?? []).filter((a) => a !== value)
                        : [...(f.required_attestations ?? []), value],
                    }))
                  }
                />
                <span style={{ fontSize: '0.875rem' }}>{label}</span>
              </label>
            );
          })}

          {(form.min_reputation_score > 0 || (form.required_attestations ?? []).length > 0) && (
            <div
              className="alert alert--info"
              style={{ marginTop: '0.75rem', fontSize: '0.82rem' }}
            >
              Contributors without these requirements will be blocked from contributing to this
              campaign.
            </div>
          )}
        </div>

        {error && (
          <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
            {error}
          </p>
        )}

        {duplicateWarning && (
          <div className="alert alert--warning" style={{ marginTop: '1rem' }} role="alert">
            <p>
              <strong>Warning:</strong> {duplicateWarning}
            </p>
            <p style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
              You can still launch it, but it will be hidden until reviewed by an admin.
            </p>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
            marginTop: '1.25rem',
          }}
        >
          <button
            type="submit"
            className="btn-primary"
            disabled={loading}
            style={{ width: '100%' }}
          >
            {loading ? t('createCampaign.creatingWallet') : t('createCampaign.launchCampaign')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            style={{ width: '100%' }}
            disabled={loading}
            onClick={onBack}
          >
            Back
          </button>
        </div>
      </>
    </>
  );
}
