import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';

// Beneficiary outcome survey — the backer's view (#960).
//
// States rendered here:
//   loading      the survey is being fetched
//   empty        the campaign has no survey (or it is still the creator's draft)
//   open         the form, prefilled with `my_response` when one exists
//   submitted    the "thanks, we recorded it" confirmation
//   closed       the survey stopped accepting responses
//   error        load or submit failure, with the previous value restored

const MAX_TEXT_ANSWER = 2000;

function RatingInput({ question, value, onChange, disabled }) {
  const { t } = useTranslation();
  const groupName = `outcome-survey-${question.id}`;
  return (
    <div role="radiogroup" aria-label={question.prompt} style={{ display: 'flex', gap: '0.5rem' }}>
      {[1, 2, 3, 4, 5].map((score) => (
        <label
          key={score}
          htmlFor={`${groupName}-${score}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.2rem',
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: '0.9rem',
          }}
        >
          <input
            id={`${groupName}-${score}`}
            type="radio"
            name={groupName}
            value={score}
            checked={Number(value) === score}
            disabled={disabled}
            onChange={() => onChange(score)}
            style={{ width: 'auto' }}
          />
          {t('outcomeSurvey.ratingLabel', { score })}
        </label>
      ))}
    </div>
  );
}

export default function OutcomeSurveyPanel({ campaignId, canRespond = true }) {
  const { t } = useTranslation();
  // Kept out of the `load` dependencies on purpose: react-i18next returns a new
  // translator identity on every render, which would restart the fetch (and its
  // setLoading(true)) in a loop.
  const tRef = useRef(t);
  tRef.current = t;

  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [answers, setAnswers] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    api
      .getOutcomeSurvey(campaignId)
      .then((data) => {
        if (!active) return;
        setPayload(data);
        // The API returns the caller's own response so a re-render (or a second
        // device) shows what they already submitted.
        setAnswers(data?.my_response?.answers || {});
        setSubmitted(Boolean(data?.my_response));
      })
      .catch((err) => {
        if (active) setLoadError(err.message || tRef.current('outcomeSurvey.loadError'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [campaignId]);

  useEffect(load, [load]);

  const survey = payload?.survey;
  const responseCount = payload?.response_count ?? 0;
  const isOpen = survey?.status === 'open';

  const setAnswer = (questionId, value) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setSubmitError('');
  };

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError('');
    try {
      await api.submitOutcomeSurveyResponse(campaignId, answers);
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err.message || t('outcomeSurvey.submitError'));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <section
        className="campaign-card"
        id="outcome-survey"
        aria-labelledby="outcome-survey-heading"
      >
        <h2 id="outcome-survey-heading" style={{ fontSize: '1.15rem' }}>
          {t('outcomeSurvey.title')}
        </h2>
        <p role="status" style={{ color: 'var(--color-text-hint)' }}>
          {t('outcomeSurvey.loading')}
        </p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section
        className="campaign-card"
        id="outcome-survey"
        aria-labelledby="outcome-survey-heading"
      >
        <h2 id="outcome-survey-heading" style={{ fontSize: '1.15rem' }}>
          {t('outcomeSurvey.title')}
        </h2>
        <p role="alert" style={{ color: 'var(--color-status-error)' }}>
          {loadError}
        </p>
      </section>
    );
  }

  // No survey, or a draft the creator has not published yet. Neither is an
  // error, so both render as a quiet empty state instead of a 404.
  if (!survey || survey.status === 'draft') {
    return (
      <section
        className="campaign-card"
        id="outcome-survey"
        aria-labelledby="outcome-survey-heading"
      >
        <h2 id="outcome-survey-heading" style={{ fontSize: '1.15rem' }}>
          {t('outcomeSurvey.title')}
        </h2>
        <p role="status" style={{ color: 'var(--color-text-hint)' }}>
          {t('outcomeSurvey.empty')}
        </p>
      </section>
    );
  }

  return (
    <section className="campaign-card" id="outcome-survey" aria-labelledby="outcome-survey-heading">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <h2 id="outcome-survey-heading" style={{ fontSize: '1.15rem', margin: 0 }}>
          {survey.title}
        </h2>
        <span
          style={{
            fontSize: '0.75rem',
            padding: '2px 8px',
            borderRadius: '99px',
            background: isOpen ? 'var(--color-accent-lightest)' : 'var(--color-bg-subtle)',
            color: isOpen ? 'var(--color-accent)' : 'var(--color-text-hint)',
          }}
        >
          {isOpen ? t('outcomeSurvey.open') : t('outcomeSurvey.closed')}
        </span>
      </div>

      {survey.intro && (
        <p style={{ color: 'var(--color-text-secondary)', marginTop: '0.5rem' }}>{survey.intro}</p>
      )}

      <p style={{ color: 'var(--color-text-hint)', fontSize: '0.85rem', marginTop: '0.35rem' }}>
        {t('outcomeSurvey.responseCount', { count: responseCount })}
      </p>

      {submitted && (
        <p role="status" style={{ marginTop: '0.75rem' }}>
          {t('outcomeSurvey.alreadyResponded')}
        </p>
      )}

      {!submitted && !isOpen && (
        <p role="status" style={{ marginTop: '0.75rem', color: 'var(--color-text-hint)' }}>
          {t('outcomeSurvey.closedNotice')}
        </p>
      )}

      {!submitted && isOpen && canRespond && (
        <form onSubmit={submit} style={{ marginTop: '0.75rem' }}>
          {(survey.questions || []).map((question) => {
            const fieldId = `outcome-survey-field-${question.id}`;
            return (
              <div key={question.id} style={{ marginBottom: '1.1rem' }}>
                {/* The required marker lives outside the <label> so the
                    accessible name of the control stays exactly the question
                    text, which keeps `getByLabelText(prompt)` exact. */}
                <label htmlFor={fieldId} style={{ fontWeight: 600, display: 'block' }}>
                  {question.prompt}
                </label>
                {question.required && (
                  <span aria-hidden="true" style={{ color: 'var(--color-status-error)' }}>
                    *{' '}
                  </span>
                )}
                {question.type === 'rating' && (
                  <RatingInput
                    question={question}
                    value={answers[question.id]}
                    disabled={submitting}
                    onChange={(value) => setAnswer(question.id, value)}
                  />
                )}
                {question.type === 'single_choice' && (
                  <select
                    id={fieldId}
                    value={answers[question.id] || ''}
                    disabled={submitting}
                    required={question.required}
                    onChange={(event) => setAnswer(question.id, event.target.value)}
                    style={{ marginTop: '0.35rem', maxWidth: '22rem' }}
                  >
                    <option value="">{t('outcomeSurvey.chooseOption')}</option>
                    {(question.options || []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                )}
                {question.type === 'text' && (
                  <textarea
                    id={fieldId}
                    value={answers[question.id] || ''}
                    maxLength={MAX_TEXT_ANSWER}
                    disabled={submitting}
                    required={question.required}
                    rows={4}
                    onChange={(event) => setAnswer(question.id, event.target.value)}
                    style={{ width: '100%', marginTop: '0.35rem' }}
                  />
                )}
              </div>
            );
          })}

          {submitError && (
            <p role="alert" style={{ color: 'var(--color-status-error)' }}>
              {submitError}
            </p>
          )}

          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? t('outcomeSurvey.submitting') : t('outcomeSurvey.submit')}
          </button>
        </form>
      )}

      {!submitted && isOpen && !canRespond && (
        <p role="status" style={{ marginTop: '0.75rem', color: 'var(--color-text-hint)' }}>
          {t('outcomeSurvey.backerOnly')}
        </p>
      )}
    </section>
  );
}
