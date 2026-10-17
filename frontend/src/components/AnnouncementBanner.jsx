import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';

const POLL_INTERVAL_MS = 60_000;
const STORAGE_KEY = 'crowdpay.dismissedAnnouncements';
const SEVERITY_RANK = {
  critical: 0,
  warning: 1,
  info: 2,
};

function readDismissed() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? new Set(value) : new Set();
  } catch {
    return new Set();
  }
}

function announcementKey(announcement) {
  return `${announcement.id}:${announcement.message}`;
}

function sortAnnouncements(announcements) {
  return [...announcements].sort((a, b) => {
    const severityDiff =
      (SEVERITY_RANK[a.severity] ?? SEVERITY_RANK.info) -
      (SEVERITY_RANK[b.severity] ?? SEVERITY_RANK.info);
    if (severityDiff !== 0) return severityDiff;
    return new Date(b.active_from || 0).getTime() - new Date(a.active_from || 0).getTime();
  });
}

export default function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState([]);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  useEffect(() => {
    let cancelled = false;

    async function loadAnnouncements() {
      try {
        const data = await api.getActiveAnnouncements();
        if (!cancelled) setAnnouncements(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setAnnouncements([]);
      }
    }

    loadAnnouncements();
    const timer = setInterval(loadAnnouncements, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const visibleAnnouncement = useMemo(() => {
    return sortAnnouncements(announcements).find((item) => !dismissed.has(announcementKey(item)));
  }, [announcements, dismissed]);

  if (!visibleAnnouncement) return null;

  function dismiss() {
    const next = new Set(dismissed);
    next.add(announcementKey(visibleAnnouncement));
    setDismissed(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  }

  const severity = visibleAnnouncement.severity || 'info';

  return (
    <div role="status" className={`announcement-banner announcement-banner--${severity}`}>
      <div className="announcement-banner__content">
        <span className="announcement-banner__message">{visibleAnnouncement.message}</span>
        {visibleAnnouncement.details_url && (
          <a
            className="announcement-banner__link"
            href={visibleAnnouncement.details_url}
            target="_blank"
            rel="noreferrer"
          >
            Details
          </a>
        )}
      </div>
      <button
        type="button"
        className="announcement-banner__dismiss"
        onClick={dismiss}
        aria-label="Dismiss announcement"
      >
        &times;
      </button>
    </div>
  );
}
