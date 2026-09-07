export function initCrowdPayEmbed(scriptTag) {
  const script = scriptTag || document.currentScript;
  if (!script) return;

  const campaignId = script.getAttribute('data-campaign');
  if (!campaignId) return;

  const theme = script.getAttribute('data-theme') || 'light';
  const rawSize = script.getAttribute('data-size') || 'medium';
  const size = ['large', 'small', 'medium'].includes(rawSize) ? rawSize : 'medium';

  const origin = window.location.origin;
  const iframe = document.createElement('iframe');
  iframe.src = `${origin}/embed/campaigns/${campaignId}?theme=${encodeURIComponent(theme)}&size=${encodeURIComponent(size)}&origin=${encodeURIComponent(origin)}`;
  iframe.title = 'CrowdPay Campaign Widget';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
  iframe.setAttribute('allow', 'payment');
  iframe.style.cssText = 'width:100%;border:0;display:block;overflow:hidden;background:transparent;';

  if (size === 'large') {
    iframe.style.minHeight = '300px';
  } else if (size === 'small') {
    iframe.style.minHeight = '140px';
  } else {
    iframe.style.minHeight = '220px';
  }

  script.parentNode.insertBefore(iframe, script);

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'resize' && event.data.height) {
      iframe.style.height = `${event.data.height}px`;
    }
    if (event.data && event.data.type === 'crowdpay:contribution') {
      window.dispatchEvent(new CustomEvent('crowdpay:contribution', { detail: event.data }));
    }
  });

  window.addEventListener('crowdpay:open', (e) => {
    if (e.detail && e.detail.campaignId === campaignId) {
      iframe.contentWindow?.postMessage({ type: 'open' }, '*');
    }
  });
}

if (typeof window !== 'undefined') {
  const current = document.currentScript;
  if (current && current.getAttribute('data-campaign')) {
    initCrowdPayEmbed(current);
  }
}