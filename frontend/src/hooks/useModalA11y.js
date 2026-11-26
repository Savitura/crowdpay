import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared dialog behaviour for the overlay modals (#1268):
 *  - Escape closes the dialog,
 *  - focus moves into the dialog when it opens and cannot Tab out of it,
 *  - focus returns to the element that opened it when the dialog unmounts.
 *
 * `resetKey` re-runs the initial focus when the dialog swaps content (for
 * example a wizard step) without moving focus back to the trigger.
 */
export function useModalA11y(modalRef, { onClose, enabled = true, resetKey } = {}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const triggerRef = useRef(null);

  // Remember what had focus so it can be restored on close.
  useEffect(() => {
    if (!enabled) return undefined;
    triggerRef.current = document.activeElement;
    return () => {
      const trigger = triggerRef.current;
      if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) {
        trigger.focus();
      }
    };
  }, [enabled]);

  // Escape to close. Listening on window keeps this working for dialogs that
  // are not yet under the app-level ModalAccessibilityManager.
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);

  // Keep Tab inside the dialog.
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event) => {
      const modal = modalRef.current;
      if (event.key !== 'Tab' || !modal) return;

      const focusable = Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, modalRef]);

  // Move focus into the dialog on open and whenever its content changes.
  useEffect(() => {
    if (!enabled) return;
    const modal = modalRef.current;
    if (!modal) return;

    const focusable = Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR));
    if (focusable.length > 0) {
      focusable[0].focus();
      return;
    }
    if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
    modal.focus();
  }, [enabled, modalRef, resetKey]);
}
