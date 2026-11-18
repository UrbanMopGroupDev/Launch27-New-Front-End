import { describe, expect, test } from 'vitest';
import { crewFor, recommendedMinutes } from './duration';

const services = [{ id: 1, duration: 240, extras: [{ id: 10, duration: 90 }, { id: 11, duration: 30, quantity_based: true }] }];
const params = [{ id: 100, duration: 30 }, { id: 101, duration: 20 }];

describe('recommended duration', () => {
  test('service + extras + pricing parameters × quantity', () => {
    // 240 + 90 (deep clean) + 30 × 2 (quantity-based extra) + 30 × 2 (full baths) + 20 × 1 (half bath) = 470
    const r = recommendedMinutes([{ id: 1, extras: [{ id: 10, quantity: 1 }, { id: 11, quantity: 2 }], pricing_parameters: [{ id: 100, quantity: 2 }, { id: 101, quantity: 1 }] }], services, params);
    expect(r).toEqual({ minutes: 470, complete: true });
  });
  test('zero quantities add nothing; missing catalog times are flagged, not guessed', () => {
    expect(recommendedMinutes([{ id: 1, pricing_parameters: [{ id: 100, quantity: 0 }] }], services, params)).toEqual({ minutes: 240, complete: true });
    expect(recommendedMinutes([{ id: 1, pricing_parameters: [{ id: 999, quantity: 1 }] }], services, params)).toEqual({ minutes: 240, complete: false });
    expect(recommendedMinutes([{ id: 2 }], services, params)).toEqual({ minutes: 0, complete: false });
    expect(recommendedMinutes([], services, params)).toBeNull();
  });
  test('crew size: 1 up to 7 h, 2 up to 10.5 h, then 3', () => {
    expect([crewFor(6 * 60), crewFor(7 * 60), crewFor(10 * 60), crewFor(11 * 60)]).toEqual([1, 2, 2, 3]);
  });
});
