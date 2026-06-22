import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initCrowdPayEmbed } from '../embed-widget/index';

describe('embed-widget script', () => {
  let container;
  let script;

  beforeEach(() => {
    container = document.createElement('div');
    container.innerHTML = '<div id="mount"></div>';
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    script = null;
  });

  function createScript(attrs = {}) {
    script = document.createElement('script');
    Object.entries(attrs).forEach(([k, v]) => script.setAttribute(k, v));
    script.setAttribute('src', '/src/embed-widget/index.js');
    document.getElementById('mount').appendChild(script);
  }

  it('is a no-op when data-campaign is missing', () => {
    createScript({ 'data-theme': 'dark' });
    initCrowdPayEmbed(script);
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });

  it('injects an iframe pointing at /embed/campaigns/:id with the theme', () => {
    createScript({ 'data-campaign': '42', 'data-theme': 'dark' });
    initCrowdPayEmbed(script);
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe.src).toContain('/embed/campaigns/42?theme=dark');
  });

  it('defaults theme to light', () => {
    createScript({ 'data-campaign': '7' });
    initCrowdPayEmbed(script);
    expect(document.querySelector('iframe').src).toContain('theme=light');
  });

  it('adds sandbox and payment allow', () => {
    createScript({ 'data-campaign': '7' });
    initCrowdPayEmbed(script);
    const iframe = document.querySelector('iframe');
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(iframe.getAttribute('allow')).toBe('payment');
  });

  it('resizes iframe on parent resize message', () => {
    createScript({ 'data-campaign': '7' });
    initCrowdPayEmbed(script);
    const iframe = document.querySelector('iframe');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'resize', height: 420 } }));
    expect(iframe.style.height).toBe('420px');
  });

  it('forwards contribution events as CustomEvent', () => {
    createScript({ 'data-campaign': '7' });
    initCrowdPayEmbed(script);
    const handler = vi.fn();
    window.addEventListener('crowdpay:contribution', handler);
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'crowdpay:contribution', amount: '10' } }),
    );
    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0].detail).toEqual({
      type: 'crowdpay:contribution',
      amount: '10',
    });
  });

  it('forwards open message into iframe', () => {
    createScript({ 'data-campaign': '7' });
    initCrowdPayEmbed(script);
    const iframe = document.querySelector('iframe');
    const popSpy = vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(() => {});
    window.dispatchEvent(
      new CustomEvent('crowdpay:open', { detail: { campaignId: '7' } }),
    );
    expect(popSpy).toHaveBeenCalledWith({ type: 'open' }, '*');
  });
});
