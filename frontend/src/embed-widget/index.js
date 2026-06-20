export function initCrowdPayEmbed(script) {
  if (!script) return;
  const campaignId = script.getAttribute('data-campaign');
  const theme = script.getAttribute('data-theme') || 'light';
  if (!campaignId) {
    console.error('CrowdPay embed: data-campaign attribute is required');
    return;
  }

  const iframe = document.createElement('iframe');
  const params = new URLSearchParams({ theme });
  iframe.src = `${window.location.origin}/embed/campaigns/${campaignId}?${params.toString()}`;
  iframe.style.width = '100%';
  iframe.style.border = 'none';
  iframe.style.borderRadius = '8px';
  iframe.style.display = 'block';
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allow', 'payment');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');

  script.parentNode.insertBefore(iframe, script.nextSibling);

  window.addEventListener('message', (event) => {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'resize' && typeof event.data.height === 'number') {
      iframe.style.height = `${event.data.height}px`;
    }
    if (event.data.type === 'crowdpay:contribution') {
      window.dispatchEvent(new CustomEvent('crowdpay:contribution', { detail: event.data }));
    }
  });

  window.addEventListener('crowdpay:open', (e) => {
    if (e.detail && String(e.detail.campaignId) === String(campaignId)) {
      iframe.contentWindow?.postMessage({ type: 'open' }, '*');
    }
  });
}

if (typeof document !== 'undefined' && document.currentScript) {
  initCrowdPayEmbed(document.currentScript);
}
