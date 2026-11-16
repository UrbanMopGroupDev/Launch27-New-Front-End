// Strip personal details from complaint text before it goes to Claude for classification
// (approved by Derek, Nov 16 2026). Emails and phones reuse the QA masker; on top of that
// we remove the names we know (client, cleaner, staff), street addresses, postal codes,
// card-like numbers and greetings/sign-offs that carry names. What's left is the complaint.
import { maskContacts } from '../qa/anonymize.js';

const POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi;
const STREET = /\b\d{1,6}[A-Z]?\s+(?:[A-Z0-9][\w'.-]*\s){0,4}(?:st|street|ave|avenue|rd|road|dr|drive|cres|crescent|crt|court|blvd|boulevard|way|lane|ln|pl|place|terr?|terrace|pvt|private|cir|circle|gate|grove|hts|heights|pkwy|parkway|sq|square)\b\.?(?:\s*(?:unit|apt|suite|#)\s*\w+)?/gi;
const UNIT = /\b(?:unit|apt|apartment|suite)\s*#?\s*\w+\b/gi;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const GREETING = /^(\s*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b)[^\n,!.]{0,40}/gim;
const SIGNOFF = /\b(thanks|thank you|regards|best|cheers|sincerely)\b[,!.]?\s*\n+\s*[^\n]{1,40}$/gim;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text, { names = [] } = {}) {
  let t = maskContacts(String(text || ''));
  const parts = new Set();
  for (const n of names) for (const p of String(n || '').split(/[\s,]+/)) if (p.length >= 3 && /^[\p{L}'-]+$/u.test(p)) parts.add(p);
  // Longest first so "Jonathan" is replaced before "Jon".
  for (const p of [...parts].sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`\\b${esc(p)}\\b`, 'gi'), '[name]');
  return t
    .replace(CARD, '[number]')
    .replace(STREET, '[address]')
    .replace(UNIT, '[unit]')
    .replace(POSTAL, '[postal code]')
    .replace(GREETING, '$1 [name]')
    .replace(SIGNOFF, '$1, [name]')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}
