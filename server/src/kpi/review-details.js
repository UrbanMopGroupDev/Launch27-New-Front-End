// Google review details for the KPI drill-down: which Launch27 client wrote it (by name) and
// which cleaners it mentions (by first name). Suggestions only, read from the bookings the
// scorecard already holds: nothing is written anywhere, and pay (the Google review bonus) is
// still recorded by a person.

const STOP = new Set(['team', 'the', 'and', 'new', 'clean', 'cleaning', 'cleaner', 'cleaners', 'crew', 'home', 'house', 'service', 'services', 'great', 'good', 'best', 'very', 'amazing', 'excellent', 'super', 'nice', 'job', 'work', 'staff', 'office', 'urban', 'urbanmop', 'mop', 'unassigned', 'tbd', 'trainee']);
export const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
const firstOf = (s) => normName(s).split(' ')[0] || '';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const memo = new WeakMap();
/** Name lookups built once per dataset from its bookings. */
export function peopleOf(bookings) {
  if (memo.has(bookings)) return memo.get(bookings);
  const cleanersByFirst = new Map(); // "maria" -> Set("Maria G.", "Maria P.")
  const clientsByName = new Map(); // "ada example" -> Map(id -> name)
  const clientsByInitial = new Map(); // "ada|e" -> Map(id -> name)
  const cleanersOfClient = new Map(); // id -> Set(cleaner)
  const add = (map, key, id, name) => (map.get(key) || map.set(key, new Map()).get(key)).set(id, name);
  for (const b of bookings || []) {
    const cleaners = String(b.cleaner || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const c of cleaners) {
      const f = firstOf(c);
      if (f.length >= 3 && !STOP.has(f)) (cleanersByFirst.get(f) || cleanersByFirst.set(f, new Set()).get(f)).add(c);
    }
    if (b.customer_id == null || !b.customer) continue;
    const n = normName(b.customer);
    const parts = n.split(' ');
    if (parts.length >= 2) {
      add(clientsByName, n, b.customer_id, b.customer);
      add(clientsByInitial, `${parts[0]}|${parts[parts.length - 1][0]}`, b.customer_id, b.customer);
    }
    const set = cleanersOfClient.get(b.customer_id) || cleanersOfClient.set(b.customer_id, new Set()).get(b.customer_id);
    for (const c of cleaners) set.add(c);
  }
  const matchers = [...cleanersByFirst.keys()].map((f) => [f, new RegExp(`(^|[^a-z])${escapeRe(f)}([^a-z]|$)`)]);
  const out = { cleanersByFirst, clientsByName, clientsByInitial, cleanersOfClient, matchers };
  memo.set(bookings, out);
  return out;
}

/** The Launch27 client a reviewer's name points to: the same full name, or the same first name and last initial ("Ada E."), when only one client fits. */
export function clientOf(reviewer, people) {
  const n = normName(reviewer);
  const parts = n.split(' ');
  if (parts.length < 2) return null;
  const exact = people.clientsByName.get(n);
  if (exact?.size === 1) {
    const [[id, name]] = [...exact];
    return { id, name, match: 'same name' };
  }
  if (exact?.size > 1) return null;
  const last = parts[parts.length - 1].replace(/\.$/, '');
  if (last.length > 1) return null; // a full surname that matched nobody
  const likely = people.clientsByInitial.get(`${parts[0]}|${last}`);
  if (likely?.size === 1) {
    const [[id, name]] = [...likely];
    return { id, name, match: 'likely' };
  }
  return null;
}

/** Cleaners a review's text names, by first name. With a matched client, a cleaner who worked for that client is picked first. */
export function cleanersIn(comment, people, clientId = null) {
  const text = normName(comment);
  if (!text) return [];
  const out = [];
  for (const [first, re] of people.matchers) {
    if (!re.test(text)) continue;
    const all = [...people.cleanersByFirst.get(first)];
    const theirs = clientId != null ? all.filter((c) => people.cleanersOfClient.get(clientId)?.has(c)) : [];
    const pick = theirs.length === 1 ? theirs : all.length === 1 ? all : null;
    out.push(pick ? { name: pick[0], sure: true } : { name: `${first[0].toUpperCase()}${first.slice(1)} (${all.length} cleaners with that name)`, sure: false });
  }
  return out;
}

const STAR = (n) => (n == null ? '' : `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`);

/** Drill rows for a list of reviews, with client and cleaner suggestions. */
export function reviewRows(reviews, bookings) {
  const people = peopleOf(bookings);
  return reviews.map((r) => {
    const client = r.reviewer ? clientOf(r.reviewer, people) : null;
    const cleaners = r.comment ? cleanersIn(r.comment, people, client?.id ?? null) : [];
    return {
      date: r.date,
      rating: r.rating ?? null,
      stars: r.rating == null ? 'Not shown by Google' : STAR(r.rating),
      reviewer: r.reviewer || '',
      comment: r.comment || '',
      client: client ? `${client.name}${client.match === 'likely' ? ' (likely)' : ''}` : '',
      client_href: client ? `/customers/${client.id}` : null,
      cleaners: cleaners.map((c) => c.name).join(', '),
      replied: r.replied == null ? '' : r.replied ? 'Yes' : 'No',
      reply: r.reply || '',
      link_href: r.link || null,
      link: r.link ? 'Open on Google' : '',
      low: r.rating != null && r.rating <= 3,
      unanswered: r.replied === false,
      counted: true,
      outcome: '',
    };
  });
}

/** "5★ 41 · 4★ 3 · 3★ 0 · 2★ 0 · 1★ 1" for the reviews with known stars. */
export function starCounts(reviews) {
  const n = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const r of reviews) if (r.rating >= 1 && r.rating <= 5) n[r.rating] += 1;
  return n;
}
