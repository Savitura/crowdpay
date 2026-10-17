(function() {
  'use strict';
  const MILESTONE_SELECTOR = '.campaign-milestone-widget';
  const IMPACT_SELECTOR = '.campaign-impact-widget';
  const DEFAULT_API_PREFIX = '/api/embed/milestones';
  const DEFAULT_IMPACT_API = '/api/campaigns';
  const DEFAULT_COLOR = '#007bff';
  const REFRESH_MS = 60000;

  function formatCurrency(amount, currency) {
    return `${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency || ''}`.trim();
  }

  function refreshMilestones() {
    document.querySelectorAll(MILESTONE_SELECTOR).forEach(el => {
      const campaignId = el.getAttribute('data-campaign-id');
      const token = el.getAttribute('data-embed-token');
      if (!campaignId || !token) return;
      const api = el.getAttribute('data-api-url') || DEFAULT_API_PREFIX;
      fetch(&campaignIds/ ${encodeURIComponent(campaignId)}?embedToken=${encodeURIComponent(token)})
        .then(r => r.json())
        .then(data => {
          const total = data.total || 0;
          const completed = data.completed || 0;
          const pct = total ? Math.round(completed / total * 100) : 0;
          const primary = el.getAttribute('data-color-primary') || (data.branding && data.branding.primaryColor) || DEFAULT_COLOR;
          const track = el.getAttribute('data-color-track') || (data.branding && data.branding.trackColor) || '#eee';
          const showPct = el.getAttribute('data-show-percentage') !== 'false';
          const label = el.getAttribute('data-label');
          let html = '';
          if (label) html += `<div style="font-family:sans-serif;font-size:14px">${label}</div>`;
          html += `<div style="background:${track};border-radius:10px;height:20px;overflow:hidden">`;
          html += `<div style="width:${pct}%;background:${primary};height:100%;border-radius:10px;transition:width 0.5s"></div>`;
          html += `</div>`;
          if (showPct) html += `<div style="font-family:sans-serif;font-size:12px">${completed} / ${total} (${pct}%)</div>`;
          el.innerHTML = html;
        })
        .catch(() => { el.innerHTML = 'Milestone data unavailable'; });
    });
  }

  function refreshImpact() {
    document.querySelectorAll(IMPACT_SELECTOR).forEach(el => {
      const campaignId = el.getAttribute('data-campaign-id');
      if (!campaignId) return;
      const api = el.getAttribute('data-api-url') || DEFAULT_IMPACT_API;
      fetch(`${api}/${encodeURIComponent(campaignId)}/impact`)
        .then(r => r.json())
        .then(data => {
          const showTotal = el.getAttribute('data-show-total') !== 'false';
          const showCount = el.getAttribute('data-show-count') !== 'false';
          const showAverage = el.getAttribute('data-show-average') === 'true';
          const showLargest = el.getAttribute('data-show-largest') === 'true';
          const showUnique = el.getAttribute('data-show-unique') === 'true';
          let html = '';
          if (showTotal) html += `<div style="font-family:sans-serif;font-size:14px">Total raised: ${formatCurrency(data.total_raised, data.currency)}</div>`;
          if (showCount) html += `<div style="font-family:sans-serif;font-size:14px">Contributions: ${data.contribution_count}</div>`;
          if (showAverage) (html += `<div style="font-family:sans-serif;font-size:14px">Average contribution: ${formatCurrency(data.average_contribution, data.currency)}</div>`;
          if (showLargest) html += `<div style="font-family:sans-serif;font-size:14px">Largest contribution: ${formatCurrency(data.largest_contribution, data.currency)}</div>`;
          if (showUnique) html += `<div style="font-family:sans-serif;font-size:14px">Unique contributors: ${data.unique_contributor_count}</div>`;
          if (html === '') html = 'Impact data unavailable';
          el.innerHTML = html;
        })
        .catch(() => { el.innerHTML = 'Impact data unavailable'; });
    });
  }

  function refresh() {
    refreshMilestones();
    refreshImpact();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh);
  } else {
    refresh();
  }
  setInterval(refresh, REFRESH_MS);

  window.CampaignImpact = { refresh, refreshImpact };
  window.CampaignMilestones = { refresh, refreshMilestones };
})();