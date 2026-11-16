// ADMIN_EMAILS is authoritative: someone added after their first sign-in becomes an admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });

test('a person added to ADMIN_EMAILS after signing up is promoted; nobody is demoted', async () => {
  const db = await openDb();
  const mock = createMockLaunch27({ password: 'demo' });
  const serve = async (adminEmails) => {
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo', ADMIN_EMAILS: adminEmails });
    const server = createApp(config, { db, fetchImpl: mock, log: quiet }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const me = async (email) => {
      const cookie = (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo' }) })).headers.get('set-cookie').split(';')[0];
      return (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()).role;
    };
    return { me, close: () => new Promise((r) => server.close(r)) };
  };

  // First sign-ins: the very first person is admin; Derek arrives later as an agent.
  const before = await serve('');
  assert.equal(await before.me('first@urbanmop.ca'), 'admin');
  assert.equal(await before.me('derek@urbanmop.ca'), 'agent');
  await before.close();

  // Derek is added to ADMIN_EMAILS: promoted on his next sign-in. The first admin stays admin.
  const after = await serve('Derek@UrbanMop.ca');
  assert.equal(await after.me('derek@urbanmop.ca'), 'admin');
  assert.equal(await after.me('first@urbanmop.ca'), 'admin');
  const audit = (await db.query("SELECT detail FROM audit_log WHERE action = 'user.promoted'")).rows;
  assert.equal(audit.length, 1);
  await after.close();
});
