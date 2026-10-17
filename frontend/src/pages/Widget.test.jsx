/* global Event */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Widget from './Widget';

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function renderWidget() {
  return render(
    <MemoryRouter initialEntries={['/embed/campaigns/test-id']}>
      <Routes>
        <Route path="/embed/campaigns/:id" element={<Widget />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Widget polling interval lifecycle', () => {
  let setIntervalSpy;
  let clearIntervalSpy;

  beforeEach(() => {
    setVisibility('visible');
    // Keep load()'s fetch pending so the effect performs no state updates.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    setIntervalSpy = vi.spyOn(window, 'setInterval');
    clearIntervalSpy = vi.spyOn(window, 'clearInterval');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setVisibility('visible');
  });

  it('clears the polling interval when the tab becomes hidden', () => {
    renderWidget();

    // On mount (visible) start() schedules the 30s poll exactly once.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const intervalId = setIntervalSpy.mock.results[0].value;

    // Hiding the tab must actually clear the interval. The bug inverted the
    // guard so stop() returned early and never reached clearInterval.
    setVisibility('hidden');
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
  });

  it('does not accumulate intervals across hide/show cycles', () => {
    renderWidget();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    setVisibility('hidden');
    setVisibility('visible');

    // Each hide clears the live interval before the next show starts a new one,
    // so exactly one interval is ever outstanding (started = cleared + 1).
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(setIntervalSpy.mock.calls.length).toBe(clearIntervalSpy.mock.calls.length + 1);
  });
});
