import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';

const MAX_CHARS = 500;

export default function ThankYouModal({ campaignId, contribution, onClose, onSent }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const modalRef = useRef(null);

  const isBulk = !contribution;
  const charsLeft = MAX_CHARS - message.length;

  useEffect(() => {
    const trigger = document.activeElement;
    return () => {
      if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) {
        trigger.focus();
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const initialFocusable = modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    initialFocusable[0]?.focus();

    function trapTab(e) {
      if (e.key !== 'Tab') return;
      const focusable = modal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) {
        e.preventDefault();
        if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
        modal.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!modal.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    modal.addEventListener('keydown', trapTab);
    return () => modal.removeEventListener('keydown', trapTab);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!message.trim() || message.length > MAX_CHARS) return;

    setSending(true);
    setError('');

    try {
      if (isBulk) {
        await api.sendBulkThankYou(campaignId, message.trim());
      } else {
        await api.sendContributionThankYou(contribution.id, message.trim());
      }
      onSent();
      onClose();
    } catch (err) {
      setError(err.message || t('thankYou.sendError'));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal-overlay" style={styles.overlay} onClick={onClose} role="presentation">
      <div
        className="modal-shell"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="thank-you-title"
        style={styles.modal}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="thank-you-title" style={{ margin: '0 0 0.5rem', fontSize: '1.1rem' }}>
          {isBulk ? t('thankYou.bulkTitle') : t('thankYou.individualTitle')}
        </h2>
        <p
          style={{ margin: '0 0 1rem', color: 'var(--color-text-secondary)', fontSize: '0.88rem' }}
        >
          {isBulk
            ? t('thankYou.bulkDescription')
            : t('thankYou.individualDescription', {
                name: contribution.display_name || 'contributor',
              })}
        </p>

        {error && (
          <p className="alert alert--error" style={{ marginBottom: '0.75rem' }}>
            {error}
          </p>
        )}

        <form onSubmit={handleSubmit}>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('thankYou.placeholder')}
            maxLength={MAX_CHARS}
            rows={4}
            style={{
              width: '100%',
              padding: '0.65rem',
              borderRadius: '8px',
              border: '1px solid var(--color-border)',
              fontSize: '0.9rem',
              resize: 'vertical',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '0.5rem',
            }}
          >
            <span
              style={{
                fontSize: '0.78rem',
                color: charsLeft < 0 ? 'var(--color-danger, #e53e3e)' : 'var(--color-text-hint)',
              }}
            >
              {charsLeft} {t('thankYou.charactersLeft')}
            </span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={onClose}
                data-modal-close="true"
                style={{ fontSize: '0.85rem', padding: '0.4rem 1rem' }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={!message.trim() || message.length > MAX_CHARS || sending}
                aria-busy={sending}
                style={{ fontSize: '0.85rem', padding: '0.4rem 1rem' }}
              >
                {sending ? 'Sending...' : t('thankYou.send')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--color-bg)',
    borderRadius: '12px',
    padding: '1.5rem',
    maxWidth: '480px',
    width: '90%',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  },
};
