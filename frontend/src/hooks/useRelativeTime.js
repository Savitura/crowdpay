import { useState, useEffect } from 'react';

function getRelative(date) {
  if (!date) return '';
  const dateObj = new Date(date);
  if (isNaN(dateObj.getTime())) return '';

  const seconds = Math.round((dateObj.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (abs < 60)     return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600)   return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400)  return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(seconds / 86400), 'day');
  // Fall back to absolute date for older events
  return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function useRelativeTime(date) {
  const [label, setLabel] = useState(() => getRelative(date));
  useEffect(() => {
    setLabel(getRelative(date));
    const id = setInterval(() => setLabel(getRelative(date)), 30_000);
    return () => clearInterval(id);
  }, [date]);
  return label;
}
