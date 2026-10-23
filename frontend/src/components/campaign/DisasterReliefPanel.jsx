import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';

const DISASTER_TYPES = [
  'flood',
  'earthquake',
  'wildfire',
  'hurricane',
  'drought',
  'conflict',
  'epidemic',
  'industrial',
  'other',
];

const SEVERITY_LEVELS = ['watch', 'urgent', 'critical', 'catastrophic'];

const EVIDENCE_TYPES = [
  'government_notice',
  'media_report',
  'ngo_registration',
  'field_assessment',
  'logistics_plan',
  'other',
];

function emptyFormState(dossier = null) {
  return {
    incident_name: dossier?.incident_name || '',
    disaster_type: dossier?.disaster_type || 'flood',
    severity_level: dossier?.severity_level || 'urgent',
    affected_region: dossier?.affected_region || '',
    affected_population:
      dossier?.affected_population !== null && dossier?.affected_population !== undefined
        ? String(dossier.affected_population)
        : '',
    responder_organization: dossier?.responder_organization || '',
    emergency_contact: dossier?.emergency_contact || '',
    evidence_items:
      Array.isArray(dossier?.evidence_items) && dossier.evidence_items.length > 0
        ? dossier.evidence_items.map((item) => ({
            title: item.title || '',
            type: item.type || 'government_notice',
            url: item.url || '',
            issuer: item.issuer || '',
          }))
        : [
            {
              title: '',
              type: 'government_notice',
              url: '',
              issuer: '',
            },
          ],
  };
}

export default function DisasterReliefPanel({ campaignId, canManage = false, isAdmin = false }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  const [dossier, setDossier] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => emptyFormState(null));
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  // Admin review & revocation state
  const [reviewNote, setReviewNote] = useState('');
  const [verificationBadge, setVerificationBadge] = useState('Verified Rapid Response');
  const [rapidDisbursementEnabled, setRapidDisbursementEnabled] = useState(true);
  const [revokeReason, setRevokeReason] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    Promise.resolve(api.getDisasterRelief?.(campaignId))
      .then((data) => {
        if (!active) return;
        const record = data?.disaster_relief ?? null;
        setDossier(record);
        setForm(emptyFormState(record));
      })
      .catch((err) => {
        if (active) {
          setLoadError(err?.message || tRef.current('disasterRelief.loadError'));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [campaignId]);

  useEffect(load, [load]);

  const canManageOrAdmin = Boolean(canManage || isAdmin);

  // Public visitors see nothing when the campaign is not in verified/revoked disaster-relief mode
  if (!canManageOrAdmin && (loading || loadError || !dossier)) {
    return null;
  }

  if (loading) {
    return (
      <section
        className="campaign-card"
        id="disaster-relief"
        aria-labelledby="disaster-relief-heading"
      >
        <h2 id="disaster-relief-heading" style={{ fontSize: '1.15rem' }}>
          {t('disasterRelief.title')}
        </h2>
        <p role="status" style={{ color: 'var(--color-text-hint)' }}>
          {t('disasterRelief.loading')}
        </p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section
        className="campaign-card"
        id="disaster-relief"
        aria-labelledby="disaster-relief-heading"
      >
        <h2 id="disaster-relief-heading" style={{ fontSize: '1.15rem' }}>
          {t('disasterRelief.title')}
        </h2>
        <p role="alert" style={{ color: 'var(--color-status-error)' }}>
          {loadError}
        </p>
      </section>
    );
  }

  const isEditableState =
    !dossier || dossier.status === 'draft' || dossier.status === 'changes_requested';

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setActionError('');
    setStatusMessage('');
  }

  function updateEvidenceItem(index, key, value) {
    setForm((prev) => {
      const next = prev.evidence_items.map((item, i) =>
        i === index ? { ...item, [key]: value } : item
      );
      return { ...prev, evidence_items: next };
    });
    setActionError('');
  }

  function addEvidenceRow() {
    setForm((prev) => ({
      ...prev,
      evidence_items: [
        ...prev.evidence_items,
        { title: '', type: 'government_notice', url: '', issuer: '' },
      ],
    }));
  }

  function removeEvidenceRow(index) {
    setForm((prev) => ({
      ...prev,
      evidence_items: prev.evidence_items.filter((_, i) => i !== index),
    }));
  }

  function buildPayload() {
    const cleanedEvidence = (form.evidence_items || []).filter(
      (item) => item.title.trim() || item.url.trim()
    );
    return {
      incident_name: form.incident_name.trim(),
      disaster_type: form.disaster_type,
      severity_level: form.severity_level,
      affected_region: form.affected_region.trim(),
      affected_population: form.affected_population.trim()
        ? Number(form.affected_population.trim())
        : null,
      responder_organization: form.responder_organization.trim() || null,
      emergency_contact: form.emergency_contact.trim() || null,
      evidence_items: cleanedEvidence,
    };
  }

  async function handleSaveDossier(event) {
    event.preventDefault();
    setSaving(true);
    setActionError('');
    setStatusMessage('');
    try {
      const payload = buildPayload();
      const response = dossier
        ? await api.updateDisasterRelief(campaignId, payload)
        : await api.createDisasterRelief(campaignId, payload);
      const updated = response?.disaster_relief || response;
      setDossier(updated);
      setForm(emptyFormState(updated));
      setEditing(false);
      setStatusMessage(t('disasterRelief.saved'));
    } catch (err) {
      setActionError(err?.message || t('disasterRelief.actionError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmitForReview() {
    setSubmitting(true);
    setActionError('');
    setStatusMessage('');
    try {
      const response = await api.submitDisasterRelief(campaignId);
      const updated = response?.disaster_relief || response;
      setDossier(updated);
      setEditing(false);
      setStatusMessage(t('disasterRelief.submitted'));
    } catch (err) {
      setActionError(err?.message || t('disasterRelief.actionError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdminReview(decision) {
    setReviewing(true);
    setActionError('');
    setStatusMessage('');
    try {
      const response = await api.reviewDisasterRelief(campaignId, {
        decision,
        note: reviewNote.trim() || null,
        verification_badge: verificationBadge.trim() || null,
        rapid_disbursement_enabled: decision === 'verified' ? rapidDisbursementEnabled : false,
      });
      const updated = response?.disaster_relief || response;
      setDossier(updated);
      setReviewNote('');
    } catch (err) {
      setActionError(err?.message || t('disasterRelief.actionError'));
    } finally {
      setReviewing(false);
    }
  }

  async function handleAdminRevoke(event) {
    event.preventDefault();
    setReviewing(true);
    setActionError('');
    setStatusMessage('');
    try {
      const response = await api.revokeDisasterRelief(campaignId, {
        reason: revokeReason.trim(),
      });
      const updated = response?.disaster_relief || response;
      setDossier(updated);
      setRevokeReason('');
    } catch (err) {
      setActionError(err?.message || t('disasterRelief.actionError'));
    } finally {
      setReviewing(false);
    }
  }

  return (
    <section
      className="campaign-card"
      id="disaster-relief"
      aria-labelledby="disaster-relief-heading"
      style={{ marginBottom: '1.5rem' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <div>
          <h2 id="disaster-relief-heading" style={{ fontSize: '1.15rem', margin: 0 }}>
            {t('disasterRelief.title')}
          </h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--color-text-hint)', margin: '0.2rem 0 0' }}>
            {t('disasterRelief.subtitle')}
          </p>
        </div>

        {dossier && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span
              data-testid="disaster-relief-status-badge"
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '0.2rem 0.6rem',
                borderRadius: '999px',
                background: 'var(--color-accent-lightest)',
                color: 'var(--color-accent)',
              }}
            >
              {t(`disasterRelief.status.${dossier.status}`)}
            </span>

            {dossier.rapid_disbursement_enabled && (
              <span
                data-testid="rapid-disbursement-badge"
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  padding: '0.2rem 0.6rem',
                  borderRadius: '999px',
                  background: 'var(--color-success-bg)',
                  color: 'var(--color-success-text)',
                }}
              >
                ⚡ {t('disasterRelief.rapidDisbursementBadge')}
              </span>
            )}
          </div>
        )}
      </div>

      {statusMessage && (
        <p role="status" style={{ color: 'var(--color-success-text)', fontSize: '0.85rem' }}>
          {statusMessage}
        </p>
      )}
      {actionError && (
        <p role="alert" style={{ color: 'var(--color-status-error)', fontSize: '0.85rem' }}>
          {actionError}
        </p>
      )}

      {/* Manager empty state: button to enable disaster-relief mode */}
      {!dossier && canManageOrAdmin && !editing && (
        <div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setEditing(true)}
            style={{ fontSize: '0.85rem' }}
          >
            {t('disasterRelief.enableButton')}
          </button>
        </div>
      )}

      {/* Summary card when a dossier exists */}
      {dossier && !editing && (
        <div style={{ display: 'grid', gap: '0.65rem', fontSize: '0.9rem' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '0.5rem',
            }}
          >
            <div>
              <strong
                style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}
              >
                {t('disasterRelief.incidentName')}
              </strong>
              <span>{dossier.incident_name}</span>
            </div>
            <div>
              <strong
                style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}
              >
                {t('disasterRelief.disasterType')}
              </strong>
              <span>{t(`disasterRelief.types.${dossier.disaster_type}`)}</span>
            </div>
            <div>
              <strong
                style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}
              >
                {t('disasterRelief.severityLevel')}
              </strong>
              <span>{t(`disasterRelief.severities.${dossier.severity_level}`)}</span>
            </div>
            <div>
              <strong
                style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}
              >
                {t('disasterRelief.affectedRegion')}
              </strong>
              <span>{dossier.affected_region}</span>
            </div>
            {dossier.affected_population && (
              <div>
                <strong
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {t('disasterRelief.affectedPopulation')}
                </strong>
                <span>{Number(dossier.affected_population).toLocaleString()}</span>
              </div>
            )}
            {dossier.responder_organization && (
              <div>
                <strong
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {t('disasterRelief.responderOrganization')}
                </strong>
                <span>{dossier.responder_organization}</span>
              </div>
            )}
          </div>

          {dossier.verification_badge && (
            <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
              🛡️ {dossier.verification_badge}
            </div>
          )}

          {dossier.sla && (
            <div
              role="status"
              style={{
                fontSize: '0.82rem',
                color: dossier.sla.is_overdue
                  ? 'var(--color-status-error)'
                  : 'var(--color-text-secondary)',
              }}
            >
              {t('disasterRelief.slaTarget', { hours: dossier.sla.target_hours })}
              {dossier.sla.is_overdue ? ` — ${t('disasterRelief.slaOverdue')}` : ''}
            </div>
          )}

          {canManageOrAdmin && dossier.review_note && (
            <div
              role="note"
              style={{
                padding: '0.6rem',
                borderRadius: '6px',
                background: 'var(--color-surface)',
                fontSize: '0.85rem',
              }}
            >
              <strong>{t('disasterRelief.reviewNote')}:</strong> {dossier.review_note}
            </div>
          )}

          {Array.isArray(dossier.evidence_items) && dossier.evidence_items.length > 0 && (
            <div>
              <strong style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.35rem' }}>
                {t('disasterRelief.evidenceTitle')}
              </strong>
              <ul style={{ margin: 0, paddingLeft: '1.15rem', fontSize: '0.85rem' }}>
                {dossier.evidence_items.map((item) => (
                  <li key={item.id || item.url}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      {item.title}
                    </a>{' '}
                    ({t(`disasterRelief.evidenceTypes.${item.type}`)})
                    {item.issuer ? ` — ${item.issuer}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canManageOrAdmin && isEditableState && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setEditing(true)}
                style={{ fontSize: '0.85rem' }}
              >
                {t('disasterRelief.saveDraft')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSubmitForReview}
                disabled={submitting}
                style={{ fontSize: '0.85rem' }}
              >
                {submitting ? t('disasterRelief.submitting') : t('disasterRelief.submitForReview')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Manager dossier editor form */}
      {canManageOrAdmin && editing && isEditableState && (
        <form onSubmit={handleSaveDossier} style={{ display: 'grid', gap: '0.75rem' }}>
          <div>
            <label htmlFor="dr-incident-name" style={{ display: 'block', fontSize: '0.85rem' }}>
              {t('disasterRelief.incidentName')}
            </label>
            <input
              id="dr-incident-name"
              value={form.incident_name}
              onChange={(e) => updateField('incident_name', e.target.value)}
              required
              maxLength={160}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '0.75rem',
            }}
          >
            <div>
              <label htmlFor="dr-disaster-type" style={{ display: 'block', fontSize: '0.85rem' }}>
                {t('disasterRelief.disasterType')}
              </label>
              <select
                id="dr-disaster-type"
                value={form.disaster_type}
                onChange={(e) => updateField('disaster_type', e.target.value)}
              >
                {DISASTER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`disasterRelief.types.${type}`)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="dr-severity-level" style={{ display: 'block', fontSize: '0.85rem' }}>
                {t('disasterRelief.severityLevel')}
              </label>
              <select
                id="dr-severity-level"
                value={form.severity_level}
                onChange={(e) => updateField('severity_level', e.target.value)}
              >
                {SEVERITY_LEVELS.map((sev) => (
                  <option key={sev} value={sev}>
                    {t(`disasterRelief.severities.${sev}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '0.75rem',
            }}
          >
            <div>
              <label htmlFor="dr-affected-region" style={{ display: 'block', fontSize: '0.85rem' }}>
                {t('disasterRelief.affectedRegion')}
              </label>
              <input
                id="dr-affected-region"
                value={form.affected_region}
                onChange={(e) => updateField('affected_region', e.target.value)}
                required
                maxLength={200}
              />
            </div>

            <div>
              <label
                htmlFor="dr-affected-population"
                style={{ display: 'block', fontSize: '0.85rem' }}
              >
                {t('disasterRelief.affectedPopulation')}
              </label>
              <input
                id="dr-affected-population"
                type="number"
                min="1"
                value={form.affected_population}
                onChange={(e) => updateField('affected_population', e.target.value)}
              />
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '0.75rem',
            }}
          >
            <div>
              <label htmlFor="dr-responder-org" style={{ display: 'block', fontSize: '0.85rem' }}>
                {t('disasterRelief.responderOrganization')}
              </label>
              <input
                id="dr-responder-org"
                value={form.responder_organization}
                onChange={(e) => updateField('responder_organization', e.target.value)}
                maxLength={200}
              />
            </div>

            <div>
              <label
                htmlFor="dr-emergency-contact"
                style={{ display: 'block', fontSize: '0.85rem' }}
              >
                {t('disasterRelief.emergencyContact')}
              </label>
              <input
                id="dr-emergency-contact"
                value={form.emergency_contact}
                onChange={(e) => updateField('emergency_contact', e.target.value)}
                maxLength={200}
              />
            </div>
          </div>

          <fieldset
            style={{
              border: '1px solid var(--color-border-lighter)',
              borderRadius: '8px',
              padding: '0.75rem',
            }}
          >
            <legend style={{ fontSize: '0.85rem', fontWeight: 600 }}>
              {t('disasterRelief.evidenceTitle')}
            </legend>
            {form.evidence_items.map((item, idx) => (
              <div
                key={idx}
                style={{
                  display: 'grid',
                  gap: '0.5rem',
                  marginBottom: '0.75rem',
                  paddingBottom: '0.5rem',
                  borderBottom: '1px solid var(--color-border-lighter)',
                }}
              >
                <div>
                  <label
                    htmlFor={`dr-evidence-title-${idx}`}
                    style={{ display: 'block', fontSize: '0.8rem' }}
                  >
                    {t('disasterRelief.evidenceItemTitle')}
                  </label>
                  <input
                    id={`dr-evidence-title-${idx}`}
                    value={item.title}
                    onChange={(e) => updateEvidenceItem(idx, 'title', e.target.value)}
                    maxLength={140}
                  />
                </div>
                <div>
                  <label
                    htmlFor={`dr-evidence-type-${idx}`}
                    style={{ display: 'block', fontSize: '0.8rem' }}
                  >
                    {t('disasterRelief.evidenceItemType')}
                  </label>
                  <select
                    id={`dr-evidence-type-${idx}`}
                    value={item.type}
                    onChange={(e) => updateEvidenceItem(idx, 'type', e.target.value)}
                  >
                    {EVIDENCE_TYPES.map((evType) => (
                      <option key={evType} value={evType}>
                        {t(`disasterRelief.evidenceTypes.${evType}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor={`dr-evidence-url-${idx}`}
                    style={{ display: 'block', fontSize: '0.8rem' }}
                  >
                    {t('disasterRelief.evidenceItemUrl')}
                  </label>
                  <input
                    id={`dr-evidence-url-${idx}`}
                    type="url"
                    value={item.url}
                    onChange={(e) => updateEvidenceItem(idx, 'url', e.target.value)}
                    placeholder="https://"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`dr-evidence-issuer-${idx}`}
                    style={{ display: 'block', fontSize: '0.8rem' }}
                  >
                    {t('disasterRelief.evidenceItemIssuer')}
                  </label>
                  <input
                    id={`dr-evidence-issuer-${idx}`}
                    value={item.issuer}
                    onChange={(e) => updateEvidenceItem(idx, 'issuer', e.target.value)}
                    maxLength={140}
                  />
                </div>
                {form.evidence_items.length > 1 && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => removeEvidenceRow(idx)}
                    style={{ fontSize: '0.8rem', width: 'fit-content' }}
                  >
                    {t('disasterRelief.removeEvidence')}
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary"
              onClick={addEvidenceRow}
              style={{ fontSize: '0.8rem' }}
            >
              {t('disasterRelief.addEvidence')}
            </button>
          </fieldset>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? t('disasterRelief.saving') : t('disasterRelief.saveDraft')}
            </button>
          </div>
        </form>
      )}

      {/* Admin Rapid Verification Review Panel */}
      {isAdmin && dossier?.status === 'pending_review' && (
        <div
          style={{
            marginTop: '1rem',
            paddingTop: '0.75rem',
            borderTop: '1px solid var(--color-border-lighter)',
            display: 'grid',
            gap: '0.6rem',
          }}
        >
          <strong style={{ fontSize: '0.9rem' }}>{t('disasterRelief.reviewSectionTitle')}</strong>
          <div>
            <label htmlFor="dr-verification-badge" style={{ display: 'block', fontSize: '0.8rem' }}>
              {t('disasterRelief.verificationBadgeLabel')}
            </label>
            <input
              id="dr-verification-badge"
              value={verificationBadge}
              onChange={(e) => setVerificationBadge(e.target.value)}
              maxLength={120}
            />
          </div>
          <div>
            <label htmlFor="dr-review-note" style={{ display: 'block', fontSize: '0.8rem' }}>
              {t('disasterRelief.reviewNote')}
            </label>
            <textarea
              id="dr-review-note"
              rows={2}
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
            />
          </div>
          <label
            htmlFor="dr-rapid-disbursement"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.85rem',
            }}
          >
            <input
              id="dr-rapid-disbursement"
              type="checkbox"
              checked={rapidDisbursementEnabled}
              onChange={(e) => setRapidDisbursementEnabled(e.target.checked)}
              style={{ width: 'auto' }}
            />
            {t('disasterRelief.rapidDisbursementBadge')}
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              disabled={reviewing}
              onClick={() => handleAdminReview('verified')}
            >
              {t('disasterRelief.approveButton')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={reviewing}
              onClick={() => handleAdminReview('changes_requested')}
            >
              {t('disasterRelief.requestChangesButton')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={reviewing}
              onClick={() => handleAdminReview('rejected')}
            >
              {t('disasterRelief.rejectButton')}
            </button>
          </div>
        </div>
      )}

      {/* Admin Revocation Control */}
      {isAdmin && dossier?.status === 'verified' && (
        <form
          onSubmit={handleAdminRevoke}
          style={{
            marginTop: '1rem',
            paddingTop: '0.75rem',
            borderTop: '1px solid var(--color-border-lighter)',
            display: 'grid',
            gap: '0.5rem',
          }}
        >
          <label htmlFor="dr-revoke-reason" style={{ display: 'block', fontSize: '0.8rem' }}>
            {t('disasterRelief.revokeReason')}
          </label>
          <input
            id="dr-revoke-reason"
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            required
          />
          <button
            type="submit"
            className="btn-secondary"
            disabled={reviewing}
            style={{ width: 'fit-content', fontSize: '0.85rem' }}
          >
            {t('disasterRelief.revokeButton')}
          </button>
        </form>
      )}
    </section>
  );
}
