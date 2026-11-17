import { describe, expect, it } from 'vitest';
import { customerPrefs, prefChips } from './customerPrefs';

describe('customerPrefs', () => {
  it('reads cleaner preferences out of tags', () => {
    const p = customerPrefs([{ name: 'VIP' }, { name: 'Prefers Dakota' }, { name: 'DO NOT assign nicole t.' }, { name: 'prefers consistent cleaner' }]);
    expect(p.prefers).toEqual(['Dakota']);
    expect(p.avoid).toEqual(['Nicole T']);
    expect(p.consistent).toBe(true);
    expect(p.prefersFemale).toBe(false);
  });

  it('tells "female only" from "prefers female"', () => {
    expect(customerPrefs(['#female cleaner only']).femaleOnly).toBe(true);
    const soft = customerPrefs(['Prefers female cleaner']);
    expect(soft.femaleOnly).toBe(false);
    expect(soft.prefersFemale).toBe(true);
    expect(soft.prefers).toEqual([]);
  });

  it('reads "no male cleaner" as a wish for a female cleaner', () => {
    const p = customerPrefs(['NO MALE cleaner']);
    expect([p.prefersFemale, p.prefersMale]).toEqual([true, false]);
    expect(customerPrefs(['Prefers male cleaner']).prefersMale).toBe(true);
  });

  it('copes with missing tags', () => {
    expect(prefChips(undefined)).toEqual([]);
    expect(prefChips([null, { name: null }, { name: 'VIP' }])).toEqual([]);
  });

  it('puts the warnings first', () => {
    const chips = prefChips(['Prefers Sam', 'Do not assign Alex', '#female cleaner only']);
    expect(chips.map((c) => c.text)).toEqual(['Never send Alex', 'Female cleaner only', 'Asks for Sam']);
    expect(chips[0].tone).toBe('warn');
  });
});
