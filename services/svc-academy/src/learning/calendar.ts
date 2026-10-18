/**
 * RFC 5545 for one session.
 *
 * Sessions store `starts_at` as timestamptz. That instant's zone is UTC.
 * The calendar says so with a trailing Z and X-WR-TIMEZONE:UTC. No local
 * zone is stored, and none is invented.
 */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatUtcIcs(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escapeIcs(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

export function sessionCalendarText(input: { sessionId: string; title: string; startsAt: Date; endsAt: Date | null; now?: Date }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Intafaced//Academy//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-TIMEZONE:UTC',
    'BEGIN:VEVENT',
    `UID:${input.sessionId}@academy`,
    `DTSTAMP:${formatUtcIcs(input.now ?? new Date())}`,
    `DTSTART:${formatUtcIcs(input.startsAt)}`,
  ];
  if (input.endsAt) lines.push(`DTEND:${formatUtcIcs(input.endsAt)}`);
  lines.push(`SUMMARY:${escapeIcs(input.title)}`, 'END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
