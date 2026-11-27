// Migration 0043 adds vincentbuenaventura.work@gmail.com as an agent ahead of their first
// sign-in: offline, in Operations Queue, listed for admins, and the same account on sign-in.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { loadMigrations, runMigrations } from '../src/db/migrate.js';
import { seed } from '../src/inbox/seed.js';
import { createApp } from '../src/app.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { loadConfig } from '../src/config.js';

const VINCENT = 'vincentbuenaventura.work@gmail.com';
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
const upTo = (v) => loadMigrations().filter((m) => m.version <= v);

describe('migration 0043: Vincent added as an agent', () => {
  test('added as an offline agent in Operations, listed for admins, and signing in uses the same account', async () => {
    const db = await openDb({ migrate: false });
    await runMigrations(db, { migrations: upTo('0042') });
    await seed(db);
    const one = async (sql, p) => (await db.query(sql, p)).rows[0];
    await db.query("INSERT INTO users (email, name, role) VALUES ('ana@example.com','Ana','admin')");

    await runMigrations(db, { migrations: upTo('0043') });
    const vincent = await one('SELECT id, name, role, active, status_id FROM users WHERE email = $1', [VINCENT]);
    assert.ok(vincent, 'added');
    assert.equal(vincent.role, 'agent');
    assert.equal(vincent.active, true);
    assert.equal(vincent.name, 'Vincent Buenaventura');
    assert.equal(Number(vincent.status_id), Number((await one("SELECT id FROM agent_statuses WHERE kind = 'offline' ORDER BY position LIMIT 1")).id), 'starts offline');
    assert.ok(await one("SELECT 1 FROM queue_members m JOIN queues q ON q.id = m.queue_id WHERE q.slug = 'operations' AND m.user_id = $1", [vincent.id]), 'in Operations Queue, as a first sign-in would be');
    assert.equal((await one("SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.added' AND detail->>'source' = 'migration 0043'")).n, 1, 'in the change history');
    assert.deepEqual(await runMigrations(db, { migrations: upTo('0043') }), [], 'runs once');

    const mock = createMockLaunch27({ password: 'demo' });
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const server = createApp(config, { db, fetchImpl: mock, log: quiet }).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const signIn = async (email) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo' }) })).headers.get('set-cookie').split(';')[0];
      const get = async (cookie, path) => (await fetch(`${base}${path}`, { headers: { cookie } })).json();

      const wf = await get(await signIn('ana@example.com'), '/api/admin/workforce');
      assert.ok(wf.agents.some((a) => a.email === VINCENT), 'listed under Agents before signing in');

      const me = await get(await signIn(VINCENT), '/api/me');
      assert.equal(Number(me.id), Number(vincent.id), 'signing in uses the added account');
      assert.equal(me.role, 'agent');
      assert.ok(me.queues.some((q) => q.slug === 'operations'));
    } finally {
      await new Promise((r) => server.close(r));
      await db.close();
    }
  });

  test('a new database adds nobody, so the first person to sign in still becomes admin', async () => {
    const db = await openDb();
    try {
      assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
    } finally {
      await db.close();
    }
  });

  test('someone already signed in keeps their account, role and queues', async () => {
    const db = await openDb({ migrate: false });
    try {
      await runMigrations(db, { migrations: upTo('0042') });
      await seed(db);
      await db.query("INSERT INTO users (email, name, role) VALUES ($1, 'Vince', 'supervisor')", [VINCENT]);
      await runMigrations(db, { migrations: upTo('0043') });
      const u = (await db.query('SELECT id, name, role FROM users WHERE email = $1', [VINCENT])).rows[0];
      assert.deepEqual([u.name, u.role], ['Vince', 'supervisor']);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM queue_members WHERE user_id = $1', [u.id])).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE detail->>'source' = 'migration 0043'")).rows[0].n, 0);
    } finally {
      await db.close();
    }
  });
});
