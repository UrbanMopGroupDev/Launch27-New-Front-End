import { describe, expect, test } from 'vitest';
import { sameSubject } from './ConversationView';

describe('email subjects in a thread', () => {
  test('reply and forward prefixes and spacing do not make a new subject', () => {
    expect(sameSubject('Re: RE: Fwd: Booking  next week')).toBe(sameSubject('Booking next week'));
    expect(sameSubject('AW: Rechnung')).toBe('rechnung');
    expect(sameSubject('Booking')).not.toBe(sameSubject('Invoice'));
  });
});
