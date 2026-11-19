// A synthetic Kustomer for development, QA and tests: dev and QA must never read the real
// Kustomer (it holds real customers' messages), so the migration page there exports this
// instead. It answers the same GET paths with JSON:API pages, built from the synthetic
// Launch27's customers and cleaners (example.com addresses), across several years, channels,
// notes and attachments, plus the awkward cases: second addresses, duplicate and conflicting
// identities, unknown people and preview-only messages.

const COMPANY = 'support@company.example'; // stand-in for our own mailbox in synthetic mail

function prng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (a) => a[Math.floor(next() * a.length)] };
}

const page = (all, query, path) => {
  const p = Math.max(1, Number(query.page) || 1);
  const n = Math.min(100, Number(query.pageSize) || 100);
  const data = all.slice((p - 1) * n, p * n);
  return { data, links: { self: `${path}?page=${p}&pageSize=${n}`, next: p * n < all.length ? `${path}?page=${p + 1}&pageSize=${n}` : null }, meta: { totalCount: all.length } };
};

export function generateKustomerData({ customers = [], teams = [], seed = 11, now = Date.UTC(2026, 10, 1), maxCustomers = 60 } = {}) {
  const r = prng(seed);
  const DAY = 86_400_000;
  const kCustomers = [];
  const conversations = new Map(); // customer id -> [conversation]
  const messages = new Map(); // conversation id -> [message]
  const notes = new Map();
  const attachments = new Map();
  let n = 0;
  const id = (p) => `${p}${(++n).toString(16).padStart(23, '0')}`;
  const addCustomer = (attrs) => {
    const c = { type: 'customer', id: id('c'), attributes: { createdAt: new Date(now - (200 + r.int(2000)) * DAY).toISOString(), ...attrs } };
    kCustomers.push(c);
    conversations.set(c.id, []);
    return c;
  };
  const SUBJECTS = ['Reschedule', 'Invoice question', 'Key pickup', 'Feedback', 'Cancel next clean', 'Add fridge', 'Quote request'];
  const addHistory = (c, { convs = 1 + r.int(3), channels = ['email', 'sms'] } = {}) => {
    const theirEmail = c.attributes.emails?.[0]?.email || null;
    for (let k = 0; k < convs; k++) {
      const ch = r.pick(channels);
      const start = now - (20 + r.int(6 * 365)) * DAY; // up to six years back
      const conv = {
        type: 'conversation',
        id: id('v'),
        attributes: { name: r.pick(SUBJECTS), status: r.next() < 0.9 ? 'done' : 'open', channels: [ch], priority: 3, createdAt: new Date(start).toISOString() },
        relationships: { customer: { data: { type: 'customer', id: c.id } }, tags: { data: r.next() < 0.3 ? [{ type: 'tag', id: 'tag-billing' }] : [] }, assignedUsers: { data: [{ type: 'user', id: 'user-agent1' }] }, assignedTeams: { data: [{ type: 'team', id: 'team-ops' }] } },
      };
      const msgs = [];
      let at = start;
      const turns = 1 + r.int(5);
      for (let t = 0; t < turns; t++) {
        const out = t % 2 === 1;
        const att = r.next() < 0.08 ? [{ type: 'attachment', id: id('a') }] : [];
        for (const a of att) attachments.set(a.id, { type: 'attachment', id: a.id, attributes: { name: 'photo.jpg', contentType: 'image/jpeg', contentLength: 120_000 + r.int(900_000) }, links: { self: `https://api.kustomerapp.com/v1/attachments/${a.id}` } });
        const body = out ? 'Thanks for reaching out, we will take care of it.' : 'Hi, could you help with my booking?';
        const previewOnly = r.next() < 0.05;
        msgs.push({
          type: 'message',
          id: id('m'),
          attributes: {
            channel: ch,
            direction: out ? 'out' : 'in',
            subject: ch === 'email' ? (t ? `Re: ${conv.attributes.name}` : conv.attributes.name) : undefined,
            preview: body.slice(0, 40),
            ...(previewOnly ? {} : { body }),
            createdAt: new Date(at).toISOString(),
            sentAt: new Date(at).toISOString(),
            meta: ch === 'email' ? { from: out ? COMPANY : theirEmail, to: [out ? theirEmail : COMPANY] } : {},
          },
          relationships: { conversation: { data: { type: 'conversation', id: conv.id } }, customer: { data: { type: 'customer', id: c.id } }, attachments: { data: att }, ...(out ? { createdBy: { data: { type: 'user', id: 'user-agent1' } } } : {}) },
        });
        at += (1 + r.int(30)) * 3_600_000;
      }
      conv.attributes.updatedAt = new Date(at).toISOString();
      if (conv.attributes.status === 'done') conv.attributes.endedAt = new Date(at).toISOString();
      messages.set(conv.id, msgs);
      notes.set(conv.id, r.next() < 0.3 ? [{ type: 'note', id: id('n'), attributes: { body: 'Customer prefers mornings.', createdAt: new Date(start + 3_600_000).toISOString() }, relationships: { conversation: { data: { type: 'conversation', id: conv.id } }, createdBy: { data: { type: 'user', id: 'user-agent1' } } } }] : []);
      conversations.get(c.id).push(conv);
    }
  };

  const people = customers.filter((c) => c.email && !c.has_generated_email).slice(0, maxCustomers);
  for (const p of people) {
    const emails = [{ type: 'home', email: p.email }];
    if (r.next() < 0.1) emails.unshift({ type: 'work', email: `work${p.id}@example.net` }); // unknown primary, known secondary
    addHistory(addCustomer({ name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), emails, phones: p.phone ? [{ type: 'mobile', phone: p.phone }] : [] }));
  }
  if (people.length > 5) {
    // The same person twice in Kustomer (a duplicate identity): both map to one customer.
    addHistory(addCustomer({ name: 'Duplicate profile', emails: [{ type: 'home', email: people[0].email }] }), { convs: 1 });
    // One Kustomer profile holding two different Launch27 customers' addresses: a conflict.
    addHistory(addCustomer({ name: 'Shared household', emails: [{ type: 'home', email: people[1].email }, { type: 'work', email: people[2].email }] }), { convs: 1 });
    // Known only by phone.
    for (let i = 3; i < 6; i++) if (people[i].phone) addHistory(addCustomer({ name: `Phone only ${i}`, phones: [{ type: 'mobile', phone: people[i].phone }] }), { convs: 1, channels: ['sms'] });
  }
  for (const t of teams.filter((x) => x.email).slice(0, 3)) addHistory(addCustomer({ name: 'Cleaner', emails: [{ type: 'work', email: t.email }] }), { convs: 1 });
  for (let i = 0; i < 8; i++) addHistory(addCustomer({ name: `Lead ${i}`, emails: [{ type: 'home', email: `lead${i}@example.org` }] }), { convs: 1, channels: ['email', 'chat'] });
  addCustomer({ name: 'No history', emails: [{ type: 'home', email: 'quiet@example.org' }] });
  return { customers: kCustomers, conversations, messages, notes, attachments };
}

/** A fake Kustomer client (same get(path, query) as complaints/sources/kustomer.js). */
export function createSyntheticKustomer(data, { hooks = {} } = {}) {
  const calls = { get: 0 };
  return {
    calls,
    data,
    async get(pathOrLink, query = {}) {
      calls.get++;
      const u = new URL(pathOrLink, 'https://api.kustomerapp.com');
      const q = { ...Object.fromEntries(u.searchParams), ...query };
      await hooks.beforeGet?.(u.pathname, q);
      const parts = u.pathname.split('/').filter(Boolean); // v1, customers, :id, conversations
      const notFound = () => Object.assign(new Error(`Kustomer ${u.pathname} returned 404`), { status: 404 });
      if (parts[1] === 'customers' && parts.length === 2) return page(data.customers, q, '/v1/customers');
      if (parts[1] === 'customers' && parts.length === 3) {
        const c = data.customers.find((x) => x.id === parts[2]);
        if (!c) throw notFound();
        return { data: c };
      }
      if (parts[1] === 'customers' && parts[3] === 'conversations') return page(data.conversations.get(parts[2]) || [], q, u.pathname);
      if (parts[1] === 'conversations' && parts[3] === 'messages') return page(data.messages.get(parts[2]) || [], q, u.pathname);
      if (parts[1] === 'conversations' && parts[3] === 'notes') return page(data.notes.get(parts[2]) || [], q, u.pathname);
      if (parts[1] === 'attachments') {
        const a = data.attachments.get(parts[2]);
        if (!a) throw notFound();
        return { data: a };
      }
      throw notFound();
    },
  };
}
