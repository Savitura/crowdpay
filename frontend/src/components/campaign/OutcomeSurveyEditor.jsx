import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';

// Beneficiary outcome survey — the creator/manager view (#960).
//
// draft   build the question set, save, then publish
// open    close early, or read the running aggregate
// closed  read the final aggregate and the lifecycle trail
//
// A survey is a research instrument, so the editor stays deliberately small:
// rating / single choice / free text, at most ten questions.

const QUESTION_TYPES = ['rating', 'single_choice', 'text'];
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 10;

function emptyQuestion() {
  return { prompt: '', type: 'rating', required: true, options: ['', ''] };
}

function toEditorQuestions(questions = []) {
  return questions.map((question) => ({
    ...question,
    options: question.options && question.options.length ? [...question.options] : ['', ''],
  }));
}

function ResultsBlock({ results, responseCount }) {
  const { t } = useTranslation();
  if (!results.length) {
    return <p style={{ color: 'var(--color-text-hint)' }}>{t('outcomeSurvey.noResults')}</p>;
  }
  return (
    <div style={{ display: 'grid', gap: '1.1rem' }}>
      {results.map((result) => {
        const entries = Object.entries(result.distribution || {});
        return (
          <div key={result.question_id}>
            <strong style={{ display: 'block' }}>{result.prompt}</strong>
            <p style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem', margin: '0.15rem 0' }}>
              {t('outcomeSurvey.answeredCount', {
                answered: result.answered,
                skipped: result.skipped,
                total: responseCount,
              })}
              {result.average_rating !== null &&
                result.average_rating !== undefined &&
                ` · ${t('outcomeSurvey.averageRating', {
                  rating: result.average_rating,
                })}`}
            </p>
            {result.type === 'text' ? (
              (result.sample_responses || []).length ? (
                <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
                  {result.sample_responses.map((sample, index) => (
                    // eslint-disable-next-line react/no-array-index-key -- samples are free text and may repeat
                    <li key={`${sample}-${index}`} style={{ fontSize: '0.9rem' }}>
                      {sample}
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ color: 'var(--color-text-hint)', fontSize: '0.85rem' }}>
                  {t('outcomeSurvey.noTextAnswers')}
                </p>
              )
            ) : (
              <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
                {entries.map(([label, count]) => (
                  <li key={label} style={{ fontSize: '0.9rem' }}>
                    {label}: {count}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function OutcomeSurveyEditor({ campaignId }) {
  const { t } = useTranslation();
  // Deliberately excluded from the `load`/`loadResults` dependencies:
  // react-i18next hands back a new translator identity on every render, which
  // would restart the fetches in a loop.
  const tRef = useRef(t);
  tRef.current = t;

  const [survey, setSurvey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [title, setTitle] = useState('');
  const [intro, setIntro] = useState('');
  const [questions, setQuestions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState(null);
  const [events, setEvents] = useState([]);

  const hydrate = useCallback((data) => {
    setSurvey(data?.survey || null);
    setTitle(data?.survey?.title || '');
    setIntro(data?.survey?.intro || '');
    setQuestions(toEditorQuestions(data?.survey?.questions));
  }, []);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    api
      .getOutcomeSurvey(campaignId)
      .then((data) => {
        if (active) hydrate(data);
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
  }, [campaignId, hydrate]);

  useEffect(load, [load]);

  const loadResults = useCallback(async () => {
    setActionError('');
    try {
      const [aggregates, trail] = await Promise.all([
        api.getOutcomeSurveyResults(campaignId),
        api.getOutcomeSurveyEvents(campaignId),
      ]);
      setResults(aggregates);
      setEvents(trail.events || []);
    } catch (err) {
      setActionError(err.message || tRef.current('outcomeSurvey.actionError'));
    }
  }, [campaignId]);

  useEffect(() => {
    if (survey && survey.status !== 'draft') loadResults();
  }, [survey, loadResults]);

  const updateQuestion = (index, patch) => {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
    setNotice('');
  };

  const removeQuestion = (index) => {
    setQuestions((prev) => prev.filter((_q, i) => i !== index));
    setNotice('');
  };

  const addQuestion = () => {
    setQuestions((prev) => (prev.length >= MAX_QUESTIONS ? prev : [...prev, emptyQuestion()]));
    setNotice('');
  };

  async function saveDraft() {
    setSaving(true);
    setActionError('');
    setNotice('');
    const payload = {
      title,
      intro: intro || null,
      questions: questions
        .filter((question) => question.prompt.trim())
        .map((question) => ({
          prompt: question.prompt,
          type: question.type,
          required: question.required !== false,
          ...(question.type === 'single_choice'
            ? { options: question.options.map((option) => option.trim()).filter(Boolean) }
            : {}),
        })),
    };
    try {
      const saved = survey
        ? await api.updateOutcomeSurvey(campaignId, payload)
        : await api.createOutcomeSurvey(campaignId, payload);
      hydrate({ survey: saved });
      setNotice(t('outcomeSurvey.saved'));
    } catch (err) {
      setActionError(err.message || t('outcomeSurvey.actionError'));
    } finally {
      setSaving(false);
    }
  }

  async function open() {
    setBusyAction('open');
    setActionError('');
    setNotice('');
    try {
      const result = await api.openOutcomeSurvey(campaignId, {});
      setSurvey(result.survey);
      setNotice(t('outcomeSurvey.opened', { count: result.invited }));
      loadResults();
    } catch (err) {
      setActionError(err.message || t('outcomeSurvey.actionError'));
    } finally {
      setBusyAction('');
    }
  }

  async function close() {
    setBusyAction('close');
    setActionError('');
    setNotice('');
    try {
      const result = await api.closeOutcomeSurvey(campaignId);
      setSurvey(result.survey);
      setNotice(t('outcomeSurvey.closedNotice'));
      loadResults();
    } catch (err) {
      setActionError(err.message || t('outcomeSurvey.actionError'));
    } finally {
      setBusyAction('');
    }
  }

  if (loading) {
    return (
      <section className="campaign-card" aria-labelledby="outcome-survey-editor-heading">
        <h2 id="outcome-survey-editor-heading" style={{ fontSize: '1.15rem' }}>
          {t('outcomeSurvey.manageTitle')}
        </h2>
        <p role="status" style={{ color: 'var(--color-text-hint)' }}>
          {t('outcomeSurvey.loading')}
        </p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="campaign-card" aria-labelledby="outcome-survey-editor-heading">
        <h2 id="outcome-survey-editor-heading" style={{ fontSize: '1.15rem' }}>
          {t('outcomeSurvey.manageTitle')}
        </h2>
        <p role="alert" style={{ color: 'var(--color-status-error)' }}>
          {loadError}
        </p>
      </section>
    );
  }

  const isDraft = !survey || survey.status === 'draft';

  return (
    <section className="campaign-card" aria-labelledby="outcome-survey-editor-heading">
      <h2 id="outcome-survey-editor-heading" style={{ fontSize: '1.15rem' }}>
        {t('outcomeSurvey.manageTitle')}
      </h2>

      {isDraft ? (
        <div style={{ marginTop: '0.75rem' }}>
          <p style={{ color: 'var(--color-text-hint)', fontSize: '0.875rem' }}>
            {t('outcomeSurvey.manageSubtitle')}
          </p>

          <label htmlFor="outcome-survey-title" style={{ fontWeight: 600, display: 'block' }}>
            {t('outcomeSurvey.fieldTitle')}
          </label>
          <input
            id="outcome-survey-title"
            type="text"
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            style={{ width: '100%', marginTop: '0.25rem' }}
          />

          <label
            htmlFor="outcome-survey-intro"
            style={{ fontWeight: 600, display: 'block', marginTop: '0.75rem' }}
          >
            {t('outcomeSurvey.fieldIntro')}
          </label>
          <textarea
            id="outcome-survey-intro"
            rows={3}
            maxLength={2000}
            value={intro}
            onChange={(event) => setIntro(event.target.value)}
            style={{ width: '100%', marginTop: '0.25rem' }}
          />

          <h3 style={{ fontSize: '1rem', marginTop: '1.1rem' }}>{t('outcomeSurvey.questions')}</h3>
          {questions.length === 0 && (
            <p style={{ color: 'var(--color-text-hint)' }}>{t('outcomeSurvey.noQuestions')}</p>
          )}

          {questions.map((question, index) => (
            <fieldset
              key={`question-${index}`}
              style={{
                border: '1px solid var(--color-border-lighter)',
                borderRadius: '8px',
                marginBottom: '0.75rem',
                padding: '0.75rem',
              }}
            >
              <legend style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                {t('outcomeSurvey.questionNumber', { number: index + 1 })}
              </legend>

              <label htmlFor={`question-prompt-${index}`} style={{ fontWeight: 600 }}>
                {t('outcomeSurvey.fieldPrompt')}
              </label>
              <input
                id={`question-prompt-${index}`}
                type="text"
                maxLength={500}
                value={question.prompt}
                onChange={(event) => updateQuestion(index, { prompt: event.target.value })}
                style={{ width: '100%', marginTop: '0.25rem' }}
              />

              <label
                htmlFor={`question-type-${index}`}
                style={{ display: 'block', marginTop: '0.6rem' }}
              >
                {t('outcomeSurvey.fieldType')}
              </label>
              <select
                id={`question-type-${index}`}
                value={question.type}
                onChange={(event) => updateQuestion(index, { type: event.target.value })}
                style={{ marginTop: '0.25rem' }}
              >
                {QUESTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`outcomeSurvey.types.${type}`)}
                  </option>
                ))}
              </select>

              {question.type === 'single_choice' && (
                <div style={{ marginTop: '0.6rem' }}>
                  <span style={{ fontWeight: 600 }}>{t('outcomeSurvey.fieldOptions')}</span>
                  {question.options.map((option, optionIndex) => (
                    <input
                      // eslint-disable-next-line react/no-array-index-key -- options are positional inputs, not identities
                      key={`option-${index}-${optionIndex}`}
                      type="text"
                      maxLength={200}
                      aria-label={t('outcomeSurvey.optionLabel', { number: optionIndex + 1 })}
                      value={option}
                      onChange={(event) => {
                        const next = [...question.options];
                        next[optionIndex] = event.target.value;
                        updateQuestion(index, { options: next });
                      }}
                      style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
                    />
                  ))}
                  {question.options.length < MAX_OPTIONS && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => updateQuestion(index, { options: [...question.options, ''] })}
                      style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}
                    >
                      {t('outcomeSurvey.addOption')}
                    </button>
                  )}
                </div>
              )}

              <label
                style={{
                  display: 'flex',
                  gap: '0.4rem',
                  alignItems: 'center',
                  marginTop: '0.6rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={question.required !== false}
                  onChange={(event) => updateQuestion(index, { required: event.target.checked })}
                  style={{ width: 'auto' }}
                />
                {t('outcomeSurvey.fieldRequired')}
              </label>

              <button
                type="button"
                className="btn-secondary"
                onClick={() => removeQuestion(index)}
                style={{ marginTop: '0.6rem', fontSize: '0.8rem' }}
              >
                {t('outcomeSurvey.removeQuestion')}
              </button>
            </fieldset>
          ))}

          <button
            type="button"
            className="btn-secondary"
            onClick={addQuestion}
            disabled={questions.length >= MAX_QUESTIONS}
            style={{ marginTop: '0.35rem' }}
          >
            {t('outcomeSurvey.addQuestion')}
          </button>

          {actionError && (
            <p role="alert" style={{ color: 'var(--color-status-error)', marginTop: '0.75rem' }}>
              {actionError}
            </p>
          )}
          {notice && (
            <p role="status" style={{ marginTop: '0.75rem' }}>
              {notice}
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={saveDraft}
              disabled={saving || !title.trim()}
            >
              {saving ? t('outcomeSurvey.saving') : t('outcomeSurvey.saveDraft')}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={open}
              disabled={busyAction === 'open' || !survey || !questions.length}
            >
              {busyAction === 'open'
                ? t('outcomeSurvey.publishing')
                : t('outcomeSurvey.openSurvey')}
            </button>
          </div>
          {!survey && (
            <p style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
              {t('outcomeSurvey.saveBeforeOpen')}
            </p>
          )}
        </div>
      ) : (
        <div style={{ marginTop: '0.75rem' }}>
          <p style={{ fontWeight: 600 }}>{survey.title}</p>
          <p style={{ color: 'var(--color-text-hint)', fontSize: '0.85rem' }}>
            {survey.status === 'open' ? t('outcomeSurvey.open') : t('outcomeSurvey.closed')}
            {results
              ? ` · ${t('outcomeSurvey.responseCount', { count: results.response_count })}`
              : ''}
          </p>

          {actionError && (
            <p role="alert" style={{ color: 'var(--color-status-error)' }}>
              {actionError}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}

          <h3 style={{ fontSize: '1rem', marginTop: '1rem' }}>{t('outcomeSurvey.results')}</h3>
          {results ? (
            <ResultsBlock results={results.results} responseCount={results.response_count} />
          ) : (
            <p role="status" style={{ color: 'var(--color-text-hint)' }}>
              {t('outcomeSurvey.loading')}
            </p>
          )}

          <h3 style={{ fontSize: '1rem', marginTop: '1.25rem' }}>{t('outcomeSurvey.history')}</h3>
          {events.length === 0 ? (
            <p style={{ color: 'var(--color-text-hint)' }}>{t('outcomeSurvey.noHistory')}</p>
          ) : (
            <ol style={{ paddingLeft: '1.1rem' }}>
              {events.map((event) => (
                <li key={event.id} style={{ fontSize: '0.85rem' }}>
                  {t(`outcomeSurvey.status.${event.to_status}`)}{' '}
                  <span style={{ color: 'var(--color-text-hint)' }}>
                    {new Date(event.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {survey.status === 'open' && (
            <button
              type="button"
              className="btn-secondary"
              onClick={close}
              disabled={busyAction === 'close'}
              style={{ marginTop: '1rem' }}
            >
              {busyAction === 'close' ? t('outcomeSurvey.closing') : t('outcomeSurvey.closeSurvey')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
