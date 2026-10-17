import { useState, useEffect } from 'react';
import i18n from 'i18next';

function getRelative(date) {
  if (!date) return '';
  const dateObj = new Date(date);
  if (isNaN(dateObj.getTime())) return '';

  const seconds = Math.round((dateObj.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const locale = i18n.language || 'en';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (abs < 60) return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(seconds / 86400), 'day');
  // Fall back to absolute date for older events
  return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Returns the refresh interval (ms) appropriate for a given timestamp age.
 * Timestamps older than 24 h are static — no interval needed.
 * Timestamps older than 1 h refresh every 5 minutes.
 * Timestamps older than 1 min refresh every 60 seconds.
 * Recent timestamps refresh every 30 seconds.
 */
function getIntervalMs(date) {
  if (!date) return null;
  const abs = Math.abs(Date.now() - new Date(date).getTime()) / 1000; // age in seconds
  if (abs >= 86400) return null; // older than 24 h — static, no timer needed
  if (abs >= 3600) return 300_000; // older than 1 h  — refresh every 5 min
  if (abs >= 60) return 60_000; // older than 1 min — refresh every 60 s
  return 30_000; // recent           — refresh every 30 s
}

export function useRelativeTime(date) {
  const [label, setLabel] = useState(() => getRelative(date));

  useEffect(() => {
    setLabel(getRelative(date));

    const intervalMs = getIntervalMs(date);
    if (intervalMs === null) return; // timestamp is old enough to be static

    const id = setInterval(() => {
      setLabel(getRelative(date));
    }, intervalMs);

    return () => clearInterval(id);
  }, [date]);

  return label;
}
