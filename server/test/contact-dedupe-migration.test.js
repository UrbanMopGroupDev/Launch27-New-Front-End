// Migration 0037 merges duplicate contacts and makes email/phone (and Launch27 links) unique.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { loadMigrations, runMigrations } from '../src/db/migrate.js';

test('0037 merges duplicates, keeps different Launch27 customers apart, retires "Who is this?"', async () => {
  const all = loadMigrations();
  const db = await openDb({ migrate: false });
  await runMigrations(db, { migrations: all.filter((m) => m.version < '0037') });
  const id = async (sql, p) => Number((await db.query(`${sql} RETURNING id`, p)).rows[0].id);
  const contact = (name, extra = {}) => id('INSERT INTO contacts (name, roles, l27_customer_id, l27_team_id, lead_stage, caller_flag, notes) VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7)', [name, JSON.stringify(extra.roles || []), extra.cust ?? null, extra.team ?? null, extra.lead ?? null, extra.flag ?? null, extra.notes ?? null]);
  const ident = (cid, kind, value, opted = false) => id('INSERT INTO contact_identities (contact_id, kind, value, opted_out, opted_out_at) VALUES ($1,$2,$3,$4,CASE WHEN $4 THEN now() END)', [cid, kind, value, opted]);
  const conv = (cid, their, needs = false, channel = 'sms') => id('INSERT INTO conversations (contact_id, channel, their_identity, needs_match) VALUES ($1,$2,$3,$4)', [cid, channel, their, needs]);

  // Jane: a customer contact, a number-only twin (spam-marked) and a lead with her email, chained.
  const jane = await contact('Jane Doe', { cust: 77, roles: ['customer'], notes: 'Gate code 1234' });
  await ident(jane, 'phone', '+16135550122');
  const bare = await contact(null, { flag: 'spam' });
  await ident(bare, 'phone', '+16135550122', true);
  await ident(bare, 'email', 'jane@example.com');
  const lead = await contact('Janie', { lead: 'New', notes: 'Wants biweekly' });
  await ident(lead, 'email', 'jane@example.com');
  await ident(lead, 'email', 'jane.work@example.com');
  const janeConv = await conv(bare, '+16135550122');
  // Two contacts for the same Launch27 customer with nothing else in common.
  const sam1 = await contact('Sam', { cust: 90, roles: ['customer'] });
  const sam2 = await contact(null, { cust: 90, roles: ['customer'] });
  await ident(sam2, 'email', 'sam@example.com');
  const samConv = await conv(sam2, 'sam@example.com', false, 'email');
  // A family phone on two different Launch27 customers: not merged, the phone stays on one.
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

  await runMigrations(db, { migrations: all });

  const c = async (cid) => (await db.query('SELECT * FROM contacts WHERE id = $1', [cid])).rows[0] || null;
  const ids = async (cid) => (await db.query('SELECT kind, value, opted_out FROM contact_identities WHERE contact_id = $1 ORDER BY kind, value', [cid])).rows;

  const j = await c(jane);
  assert.equal(j.name, 'Jane Doe');
  assert.equal(j.caller_flag, null, 'a spam mark is not copied onto a Launch27 customer');
  assert.equal(j.lead_stage, 'New');
  assert.equal(j.notes, 'Gate code 1234\n\nWants biweekly');
  assert.deepEqual(await ids(jane), [
    { kind: 'email', value: 'jane.work@example.com', opted_out: false },
    { kind: 'email', value: 'jane@example.com', opted_out: false },
    { kind: 'phone', value: '+16135550122', opted_out: true },
  ]);
  assert.equal(await c(bare), null);
  assert.equal(await c(lead), null);
  assert.equal(Number((await db.query('SELECT contact_id FROM conversations WHERE id = $1', [janeConv])).rows[0].contact_id), jane);

  assert.equal(await c(sam2), null);
  assert.deepEqual((await ids(sam1)).map((i) => i.value), ['sam@example.com']);
  assert.equal(Number((await db.query('SELECT contact_id FROM conversations WHERE id = $1', [samConv])).rows[0].contact_id), sam1);

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

  const merged = (await db.query("SELECT object_id, detail FROM audit_log WHERE action = 'contact.merged' ORDER BY object_id")).rows;
  assert.deepEqual(merged.map((r) => Number(r.object_id)).sort((x, y) => x - y), [jane, sam1, a].sort((x, y) => x - y));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'identity.deduplicated'")).rows[0].n, 1);

  // From now on an email or phone has one contact, and a Launch27 customer one contact.
  await assert.rejects(ident(sam1, 'phone', '+16135550122'));
  await assert.rejects(contact('Another Jane', { cust: 77 }));
  await db.close();
});
