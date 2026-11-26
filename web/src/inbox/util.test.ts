import { describe, expect, test } from 'vitest';
import { ago, fillTemplate, slaText, displayIdentity, firstName, dayBucket, rowTime, sinceISO } from './util';

describe('workspace helpers', () => {
  const now = new Date('2026-11-02T15:00:00Z').getTime();
  test('ago', () => {
    expect(ago('2026-11-02T14:58:00Z', now)).toBe('2m');
    expect(ago('2026-11-02T12:00:00Z', now)).toBe('3h');
    expect(ago('2026-10-30T15:00:00Z', now)).toBe('3d');
  });
  test('sla countdown and tone', () => {
    expect(slaText('2026-11-02T15:04:00Z', now)).toEqual({ text: '4m left', tone: 'warn' });
    expect(slaText('2026-11-02T14:50:00Z', now)).toEqual({ text: '10m late', tone: 'late' });
    expect(slaText('2026-11-02T16:30:00Z', now)?.tone).toBe('ok');
    expect(slaText(null, now)).toBeNull();
  });
  test('templates keep unknown placeholders visible', () => {
    expect(fillTemplate('Hi {{first_name}}, ETA {{eta}}', { first_name: 'Jane' })).toBe('Hi Jane, ETA {{eta}}');
  });
  test('identities and names', () => {
    expect(displayIdentity('+16136919880')).toBe('(613) 691-9880');
    expect(displayIdentity('jane@x.ca')).toBe('jane@x.ca');
    expect(firstName({ name: 'Jane Doe' })).toBe('Jane');
    expect(firstName(null)).toBe('there');
  });
  test('day buckets in the business time zone', () => {
    // now = Mon Nov 2, 10:00 Toronto time
    expect(dayBucket('2026-11-02T13:00:00Z', now)).toBe('Today');
    expect(dayBucket('2026-11-02T04:30:00Z', now)).toBe('Yesterday'); // 11:30pm Nov 1 local
    expect(dayBucket('2026-10-29T15:00:00Z', now)).toBe('Earlier this week');
    expect(dayBucket('2026-10-24T15:00:00Z', now)).toBe('Last week');
    expect(dayBucket('2026-09-10T15:00:00Z', now)).toMatch(/September/);
  });
  test('row time shows clock time today, a date when older', () => {
    expect(rowTime('2026-11-02T14:15:00Z', now)).toMatch(/9:15/);
    expect(rowTime('2026-10-03T14:15:00Z', now)).toMatch(/Oct/);
  });
  test('since today starts at local midnight', () => {
    expect(sinceISO('today', now)).toBe('2026-11-02T05:00:00.000Z');
    expect(sinceISO('', now)).toBeUndefined();
  });
});
