// What a customer's Launch27 tags say about who should clean for them.
// Same reading as the scheduler's server-side rules (server/src/schedule/rules.js, customerPrefs),
// so the Dispatch board and the Scheduling page describe a client the same way.

export type PrefChip = { text: string; tone: 'good' | 'warn' | 'neutral' };

const tidy = (s: string) => s.replace(/[^a-zÀ-ɏ' -]/gi, '').trim();
const titleCase = (s: string) => s.replace(/(^|[\s-])([a-zà-ɏ])/g, (_, a: string, b: string) => a + b.toUpperCase());

export function customerPrefs(tags: ({ name?: string | null } | string | null | undefined)[] = []) {
  const names = tags.map((t) => String((typeof t === 'string' ? t : t?.name) ?? '').trim()).filter(Boolean);
  const lc = names.map((x) => x.toLowerCase());
  const prefers: string[] = [];
  const avoid: string[] = [];
  for (const x of lc) {
    const no = x.match(/do\s*not\s*assign\s+(.+)/);
    if (no) {
      avoid.push(titleCase(tidy(no[1])));
      continue;
    }
    const p = x.match(/^#?\s*prefer(?:s|red)?\s+(.+)/);
    if (p && !/female|male|consistent|same/.test(p[1])) prefers.push(titleCase(tidy(p[1])));
  }
  // "No male cleaner" is a wish for a female cleaner (same rule as the server).
  const noMale = (x: string) => /\b(no|not|never|without|doesn'?t want|does not want|don'?t want|do not want)\b[^.]*\bmale\b/.test(x) && !/do\s*not\s*(?:assign|send)/.test(x);
  return {
    femaleOnly: lc.some((x) => /female/.test(x) && /only/.test(x)),
    prefersFemale: lc.some((x) => /female/.test(x) || noMale(x)),
    prefersMale: lc.some((x) => /\bmale\b/.test(x) && !/female/.test(x) && !noMale(x)),
    consistent: lc.some((x) => /consistent|same cleaner/.test(x)),
    prefers: prefers.filter(Boolean),
    avoid: avoid.filter(Boolean),
  };
}

/** The preferences as short plain-language chips, warnings first. */
export function prefChips(tags: Parameters<typeof customerPrefs>[0]): PrefChip[] {
  const p = customerPrefs(tags);
  const chips: PrefChip[] = [];
  for (const n of p.avoid) chips.push({ text: `Never send ${n}`, tone: 'warn' });
  if (p.femaleOnly) chips.push({ text: 'Female cleaner only', tone: 'warn' });
  else if (p.prefersFemale) chips.push({ text: 'Prefers a female cleaner', tone: 'neutral' });
  if (p.prefersMale) chips.push({ text: 'Prefers a male cleaner', tone: 'neutral' });
  if (p.consistent) chips.push({ text: 'Wants the same cleaner every time', tone: 'neutral' });
  for (const n of p.prefers) chips.push({ text: `Asks for ${n}`, tone: 'good' });
  return chips;
}
