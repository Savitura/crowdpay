import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useModalA11y } from './useModalA11y';

function Harness({ onClose, step = 1 }) {
  const modalRef = useRef(null);
  useModalA11y(modalRef, { onClose, resetKey: step });

  return (
    <div>
      <button type="button">Open trigger</button>
      <button type="button">Outside button</button>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-label="Test dialog">
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </div>
    </div>
  );
}

describe('useModalA11y', () => {
  it('moves focus into the dialog when it opens', () => {
    render(<Harness onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog', () => {
    render(<Harness onClose={() => {}} />);
    const first = screen.getByRole('button', { name: 'First action' });
    const last = screen.getByRole('button', { name: 'Last action' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('pulls focus back into the dialog when it escaped to the page', () => {
    render(<Harness onClose={() => {}} />);
    const first = screen.getByRole('button', { name: 'First action' });
    const outside = screen.getByRole('button', { name: 'Outside button' });

    outside.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();
  });

  it('restores focus to the trigger when the dialog unmounts', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Page action';
    document.body.appendChild(outside);
    outside.focus();

    const { unmount } = render(<Harness onClose={() => {}} />);
    expect(outside).not.toHaveFocus();

    unmount();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('closes through Escape after the dialog content changes', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness onClose={onClose} step={1} />);
    rerender(<Harness onClose={onClose} step={2} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
