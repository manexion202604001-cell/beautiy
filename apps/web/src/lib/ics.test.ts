import { describe, expect, it } from 'vitest';
import { buildIcs } from './ics';

describe('buildIcs', () => {
  it('produces a valid VEVENT with UTC times, escaping and CRLF', () => {
    const ics = buildIcs(
      {
        uid: 'a1@salon-os',
        start: '2026-10-01T05:30:00.000Z',
        end: '2026-10-01T06:30:00.000Z',
        summary: 'Salon Demo, 渋谷; ご予約',
        description: '1行目\n2行目',
      },
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('DTSTART:20261001T053000Z');
    expect(ics).toContain('DTEND:20261001T063000Z');
    expect(ics).toContain('SUMMARY:Salon Demo\\, 渋谷\\; ご予約');
    expect(ics).toContain('DESCRIPTION:1行目\\n2行目');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('folds long lines at 75 octets', () => {
    const ics = buildIcs({
      uid: 'x',
      start: '2026-10-01T05:30:00Z',
      end: '2026-10-01T06:30:00Z',
      summary: 'あ'.repeat(60),
    });
    for (const line of ics.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});
