import { normalizeReportDate } from './research-model.js';

/** A static all-day calendar file. No identifiers, subscriptions, alarms or automatic actions. */
export function createResearchReminder(day: string, now = new Date().toISOString()): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Choose a valid reminder date.');
  const date = normalizeReportDate(day + 'T00:00:00Z');
  const created = normalizeReportDate(now);
  if (!date || !created) throw new Error('Choose a valid reminder date.');
  const next = new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
  const stamp = created.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AgentToll//Research reminder//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:research-${day}-${stamp}@agenttoll.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day.replaceAll('-', '')}`,
    `DTEND;VALUE=DATE:${next}`, 'SUMMARY:Revisit saved token research',
    'DESCRIPTION:Open AgentToll in the browser where your research is saved.',
    'URL:https://agenttoll.app/research.html', 'TRANSP:TRANSPARENT', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
