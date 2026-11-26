// Migration 0038 merges duplicate contacts and makes email/phone (and Launch27 links) unique.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { loadMigrations, runMigrations } from '../src/db/migrate.js';

async function before0038() {
  const all = loadMigrations();
  const db = await openDb({ migrate: false });
  await runMigrations(db, { migrations: all.filter((m) => m.version < '0038') });
  const id = async (sql, p) => Number((await db.query(`${sql} RETURNING id`, p)).rows[0].id);
  const h = {
    db,
    all,
    contact: (name, extra = {}) => id('INSERT INTO contacts (name, roles, l27_customer_id, l27_team_id, lead_stage, caller_flag, notes) VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7)', [name, JSON.stringify(extra.roles || []), extra.cust ?? null, extra.team ?? null, extra.lead ?? null, extra.flag ?? null, extra.notes ?? null]),
    ident: (cid, kind, value, opted = false) => id('INSERT INTO contact_identities (contact_id, kind, value, opted_out, opted_out_at) VALUES ($1,$2,$3,$4,CASE WHEN $4 THEN now() END)', [cid, kind, value, opted]),
    conv: (cid, their, needs = false, channel = 'sms') => id('INSERT INTO conversations (contact_id, channel, their_identity, needs_match) VALUES ($1,$2,$3,$4)', [cid, channel, their, needs]),
    c: async (cid) => (await db.query('SELECT * FROM contacts WHERE id = $1', [cid])).rows[0] || null,
    ids: async (cid) => (await db.query('SELECT kind, value, opted_out, opted_out_by FROM contact_identities WHERE contact_id = $1 ORDER BY kind, value', [cid])).rows,
    convContact: async (vid) => Number((await db.query('SELECT contact_id FROM conversations WHERE id = $1', [vid])).rows[0].contact_id),
    migrate: () => runMigrations(db, { migrations: all }),
  };
  return h;
}

test('0038 merges duplicates and chains of them, keeps different Launch27 people apart, retires "Who is this?"', async () => {
  const { db, contact, ident, conv, c, ids, convContact, migrate } = await before0038();

  // Jane: a customer contact, a number-only twin (spam-marked) and a lead with her email, chained
  // through the twin (lead -email- twin -phone- Jane).
  const jane = await contact('Jane Doe', { cust: 77, roles: ['customer'], notes: 'Gate code 1234' });
  await ident(jane, 'phone', '+16135550122');
  const bare = await contact(null, { flag: 'spam' });
  await ident(bare, 'phone', '+16135550122', true);
  await ident(bare, 'email', 'jane@example.com');
  const lead = await contact('Janie', { lead: 'New', notes: 'Wants biweekly' });
  await ident(lead, 'email', 'jane@example.com');
  await ident(lead, 'email', 'jane.work@example.com');
  const janeConv = await conv(bare, '+16135550122');
  const leadConv = await conv(lead, 'jane.work@example.com', false, 'email');
  // Two contacts for the same Launch27 customer with nothing else in common.
  const sam1 = await contact('Sam', { cust: 90, roles: ['customer'] });
  const sam2 = await contact(null, { cust: 90, roles: ['customer'] });
  await ident(sam2, 'email', 'sam@example.com');
  const samConv = await conv(sam2, 'sam@example.com', false, 'email');
  // A household phone on two different Launch27 customers: not merged, the phone stays on one.
  const kid = await contact('Kid', { cust: 81, roles: ['customer'] });
  await ident(kid, 'phone', '+16135550500');
  const parent = await contact('Parent', { cust: 82, roles: ['customer'] });
  await ident(parent, 'phone', '+16135550500');
  await ident(parent, 'email', 'parent@example.com');
  // A "Who is this?" conversation between two unlinked contacts sharing an email.
  const a = await contact('Pat A');
  await ident(a, 'email', 'pat@example.com');
  const b = await contact('Pat B', { roles: ['applicant'] });
  await ident(b, 'email', 'pat@example.com');
  const patConv = await conv(null, 'pat@example.com', true, 'email');
  const lone = await conv(null, 'nobody@example.com', true, 'email');

  await migrate();

  const j = await c(jane);
  assert.equal(j.name, 'Jane Doe');
  assert.equal(j.caller_flag, null, 'a spam mark is not copied onto a Launch27 customer');
  assert.equal(j.lead_stage, 'New');
  assert.equal(j.notes, 'Gate code 1234\n\nWants biweekly');
  assert.deepEqual(await ids(jane), [
    { kind: 'email', value: 'jane.work@example.com', opted_out: false, opted_out_by: null },
    { kind: 'email', value: 'jane@example.com', opted_out: false, opted_out_by: null },
    { kind: 'phone', value: '+16135550122', opted_out: true, opted_out_by: 'stop' },
  ]);
  assert.equal(await c(bare), null);
  assert.equal(await c(lead), null);
  assert.equal(await convContact(janeConv), jane);
  assert.equal(await convContact(leadConv), jane);

  assert.equal(await c(sam2), null);
  assert.deepEqual((await ids(sam1)).map((i) => i.value), ['sam@example.com']);
  assert.equal(await convContact(samConv), sam1);

  assert.ok(await c(kid));
  assert.ok(await c(parent));
  assert.deepEqual((await ids(kid)).map((i) => i.value), ['+16135550500']);
  assert.deepEqual((await ids(parent)).map((i) => i.value), ['parent@example.com']);

  const pat = await c(a);
  assert.deepEqual(pat.roles, ['applicant']);
  assert.equal(await c(b), null);
  const pc = (await db.query('SELECT contact_id, needs_match FROM conversations WHERE id = $1', [patConv])).rows[0];
  assert.equal(Number(pc.contact_id), a);
  assert.equal(pc.needs_match, false);
  assert.equal((await db.query('SELECT needs_match FROM conversations WHERE id = $1', [lone])).rows[0].needs_match, false);

  const merged = (await db.query("SELECT DISTINCT object_id FROM audit_log WHERE action = 'contact.merged'")).rows.map((r) => Number(r.object_id));
  assert.deepEqual(merged.sort((x, y) => x - y), [jane, sam1, a].sort((x, y) => x - y));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'identity.deduplicated'")).rows[0].n, 1);

  // From now on an email or phone has one contact, and a Launch27 customer one contact.
  await assert.rejects(ident(sam1, 'phone', '+16135550122'));
  await assert.rejects(contact('Another Jane', { cust: 77 }));
  await db.close();
});

test('0038: shared household numbers and placeholder emails prove nothing; unlinked contacts join the right person', async () => {
  const { db, contact, ident, conv, c, ids, convContact, migrate } = await before0038();

  // Customers #11 and #12 share a household phone. U1 has #11's email and a phone shared with U2.
  const c11 = await contact('Eleven', { cust: 11, roles: ['customer'] });
  await ident(c11, 'phone', '+16135551100');
  await ident(c11, 'email', 'eleven@example.com');
  const c12 = await contact('Twelve', { cust: 12, roles: ['customer'] });
  await ident(c12, 'phone', '+16135551100');
  await ident(c12, 'email', 'twelve@example.com');
  const u1 = await contact(null);
  await ident(u1, 'email', 'eleven@example.com');
  await ident(u1, 'phone', '+16135551199');
  const u2 = await contact('Number friend');
  await ident(u2, 'phone', '+16135551199');
  const u2Conv = await conv(u2, '+16135551199');

  // Five customers share a placeholder email; an unlinked twin of #5 has #5's phone and the placeholder.
  const placeholder = [];
  for (let n = 1; n <= 5; n++) {
    const p = await contact(`Customer ${n}`, { cust: 500 + n, roles: ['customer'] });
    await ident(p, 'email', 'noemail@example.com');
    await ident(p, 'phone', `+1613555150${n}`);
    placeholder.push(p);
  }
  const twin = await contact(null);
  await ident(twin, 'phone', '+16135551505');
  await ident(twin, 'email', 'noemail@example.com');
  const twinConv = await conv(twin, '+16135551505');

  // A number-only contact whose only number is the household phone: it loses it, with a note.
  const lonely = await contact('Lonely', { notes: 'Called about a quote' });
  await ident(lonely, 'phone', '+16135551100');
  await conv(lonely, '+16135551100');

  // Phase 1 chain: A (customer 1), B (customer 1, cleaner 5), C (customer 2, cleaner 5).
  const pa = await contact('A', { cust: 1, roles: ['customer'] });
  await ident(pa, 'email', 'a@example.com');
  const pb = await contact('B', { cust: 1, team: 5, roles: ['customer', 'cleaner'] });
  const pc = await contact('C', { cust: 2, team: 5, roles: ['customer', 'cleaner'] });
  await ident(pc, 'email', 'c@example.com');

  await migrate();

  // U1 and U2 joined #11 through #11's email; #12 keeps its own email; the household phone stays on one.
  assert.equal(await c(u1), null);
  assert.equal(await c(u2), null);
  assert.equal(await convContact(u2Conv), c11);
  assert.deepEqual((await ids(c11)).map((i) => i.value), ['eleven@example.com', '+16135551100', '+16135551199']);
  assert.deepEqual((await ids(c12)).map((i) => i.value), ['twelve@example.com']);
  assert.equal((await c(c11)).name, 'Eleven');

  // The twin joined #5 (its phone), not whoever kept the placeholder email.
  assert.equal(await c(twin), null);
  assert.equal(await convContact(twinConv), placeholder[4]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM contact_identities WHERE value = 'noemail@example.com'")).rows[0].n, 1);
  for (const p of placeholder) assert.ok(await c(p), 'customers are never merged with each other here');

  const l = await c(lonely);
  assert.deepEqual(await ids(lonely), []);
  assert.match(l.notes, /^Called about a quote\n\n\+16135551100 was also on contact #\d+ and now stays only there\.$/);

  // Phase 1: A joins B (the same customer); C is a different customer, so it keeps customer 2 and
  // gives up the cleaner link it shared with B.
  assert.equal(await c(pa), null);
  const b = await c(pb);
  assert.equal(Number(b.l27_customer_id), 1);
  assert.equal(Number(b.l27_team_id), 5);
  assert.deepEqual((await ids(pb)).map((i) => i.value), ['a@example.com']);
  const cc = await c(pc);
  assert.equal(Number(cc.l27_customer_id), 2);
  assert.equal(cc.l27_team_id, null);
  assert.deepEqual((await ids(pc)).map((i) => i.value), ['c@example.com']);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'contact.unlinked' AND object_id = $1", [String(pc)])).rows[0].n, 1);
  await db.close();
});
