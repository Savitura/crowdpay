/* global HTMLElement, MutationObserver */
import { useEffect } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Applies the keyboard contract to every dialog marked with aria-modal.
 * Keeping this at the application boundary means newly added dialogs receive
 * the same Escape, focus containment, and focus-return behaviour automatically.
 */
export default function ModalAccessibilityManager() {
  useEffect(() => {
    const previousFocus = new Map();

    const scan = () => {
      const dialogs = new Set(document.querySelectorAll('[aria-modal="true"]'));
      dialogs.forEach((dialog) => {
        if (!previousFocus.has(dialog)) {
          const active = document.activeElement;
          previousFocus.set(
            dialog,
            active instanceof HTMLElement && !dialog.contains(active) ? active : null
          );
        }
      });

      for (const [dialog, trigger] of previousFocus) {
        if (!dialogs.has(dialog)) {
          if (trigger?.isConnected) trigger.focus();
          previousFocus.delete(dialog);
        }
      }
    };

    const onKeyDown = (event) => {
      const dialogs = [...document.querySelectorAll('[aria-modal="true"]')];
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return;

      if (event.key === 'Escape') {
        const closeButton = dialog.querySelector(
          'button[aria-label*="close" i], [data-modal-close="true"]'
        );
        if (closeButton instanceof HTMLElement) {
          event.preventDefault();
          closeButton.click();
        }
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll(FOCUSABLE)].filter(
        (element) => element instanceof HTMLElement && element.offsetParent !== null
      );
      if (focusable.length === 0) {
        event.preventDefault();
        if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      const currentIndex = focusable.indexOf(active);
      if (currentIndex === -1) {
        event.preventDefault();
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
      } else if (event.shiftKey && currentIndex === 0) {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0].focus();
      }
    };

    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('keydown', onKeyDown, true);
    scan();

    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  return null;
}
