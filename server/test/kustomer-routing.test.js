// Queues, routing rules and teams taken from Kustomer (routing export of Nov 25, 2026):
// the seeded rules send Kustomer's cases where Kustomer sends them, and migration 0036 moves
// a database seeded before that export to the same configuration.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { loadMigrations, runMigrations } from '../src/db/migrate.js';
import { QUEUES, RULES, UM, seed } from '../src/inbox/seed.js';
import { DEFAULT_TEAMS } from '../src/inbox/workforce.js';
import { route } from '../src/inbox/routing.js';
import { createApp } from '../src/app.js';
import { createMockLaunch27 } from '../src/mock/launch27.js';
import { loadConfig } from '../src/config.js';

const rules = RULES.map((r, i) => ({ ...r, id: i + 1, position: (i + 1) * 10 }));
const ctx = (over) => ({ channel: 'email', to: UM.info, from: 'jane@example.com', subject: '', body: '', roles: [], ...over });
const sent = (over) => {
  const { rule, action } = route(rules, ctx(over));
  return { queue: action.queue, rule: rule?.name || null, sla: action.sla };
};
const NEW_AGENTS = ['mabutecarmelad@gmail.com', 'khaje91aquino@gmail.com', 'simon@urbanmop.ca'];

describe('Kustomer routing: seeded queues, rules and teams', () => {
  test("every Kustomer queue rule is here, on or off as in Kustomer, and every rule's queue exists", () => {
    const kustomer = {
      'Sales Overflow(Cart Abandonment) Rule': true,
      'Keep in Sales Queue': true,
      'Sales Queue Rule': true,
      'Facebook or Instagram to Sales Queue': true,
      '1-3 Star Google Review to Jose': false,
      'HR email': true,
      'Billing & Financial Operations Queue': true,
      'Financial Operations Rule': true,
      'Admin Queue rule': true,
      'Operations Queue Rule': true,
      'Billing Routing': false,
      'HR Queue Rule': true,
      'Google Reviews Rule': true,
      'Operations - Chat Rule': true,
      'Jose Queue': true,
      'Payroll Queue Rule': true,
      'Operations Queue (Cleaner Enroute/Check In Delay) Rule': true,
      'Action from CEL Report route to Operations': true,
      'Route to Customer Success': true,
      'Accounts Receivables Rule': false,
      'Promo ticket email to sales queue': false,
    };
    for (const [name, enabled] of Object.entries(kustomer)) {
      const rule = RULES.find((r) => r.name === name);
      assert.ok(rule, `missing Kustomer rule ${name}`);
      assert.equal(rule.enabled !== false, enabled, `${name} should be ${enabled ? 'on' : 'off'}`);
    }
    const slugs = new Set(QUEUES.map((q) => q.slug));
    for (const r of RULES) if (r.action.queue) assert.ok(slugs.has(r.action.queue), `${r.name} sends to unknown queue ${r.action.queue}`);
    for (const t of DEFAULT_TEAMS) for (const s of t.queues) assert.ok(slugs.has(s), `${t.name} works unknown queue ${s}`);
    assert.equal(new Set(RULES.map((r) => r.name.toLowerCase())).size, RULES.length, 'rule names are unique');
  });

  test('sales: cart abandonment, lead follow-up, inquiries, chat, sales@, Facebook and Instagram leads', () => {
    assert.deepEqual(sent({ subject: 'Cart Abandoned: Jane' }), { queue: 'sales-overflow', rule: 'Sales Overflow(Cart Abandonment) Rule', sla: 'cart' });
    assert.equal(sent({ leadStage: 'Non-Region' }).queue, 'sales');
    assert.equal(sent({ subject: 'New Booking by Customer Jane' }).rule, 'Sales Queue Rule');
    assert.equal(sent({ subject: 'Black Friday deal' }).queue, 'sales');
    assert.equal(sent({ body: 'Could I get a quote for Friday?' }).queue, 'sales');
    assert.equal(sent({ to: UM.sales, body: 'Hello' }).queue, 'sales');
    assert.equal(sent({ channel: 'chat', to: null }).rule, 'Sales Queue Rule');
    assert.equal(sent({ subject: 'New Facebook Lead: Jane' }).rule, 'Facebook or Instagram to Sales Queue');
  });

  test('billing, financial operations, payroll, HR and the other team queues', () => {
    assert.equal(sent({ subject: 'INTERAC e-Transfer: you received money' }).queue, 'billing');
    assert.equal(sent({ channel: 'sms', to: UM.smsOttawa, from: '+18449282412', body: 'Payment notice' }).queue, 'billing');
    assert.equal(sent({ subject: 'Warning: The credit cards for 3 customers failed' }).queue, 'financial-operations');
    assert.equal(sent({ subject: '2 bookings that need to be charged' }).queue, 'financial-operations');
    assert.equal(sent({ to: UM.payroll }).queue, 'payroll');
    assert.equal(sent({ channel: 'sms', to: UM.smsOttawa, body: 'When is payroll this week?' }).queue, 'payroll');
    // Kustomer's order: "Operations Queue Rule" (email to info@) comes before "Payroll Queue Rule".
    assert.equal(sent({ body: 'When is payroll this week?' }).queue, 'operations');
    assert.equal(sent({ to: UM.hr }).rule, 'HR email');
    assert.equal(sent({ to: UM.careers }).queue, 'hr');
    assert.equal(sent({ to: 'someone@urbanmop.ca', from: 'docs@email.pandadoc.net', subject: 'Document completed' }).queue, 'hr');
    assert.equal(sent({ to: 'someone@urbanmop.ca', subject: 'myBackCheck.com Notification' }).queue, 'hr');
    assert.equal(sent({ to: UM.hiring }).queue, 'hr');
    assert.equal(sent({ to: UM.jose }).queue, 'jose');
    assert.equal(sent({ to: UM.customerSuccess }).queue, 'customer-success');
    assert.equal(sent({ to: 'someone@urbanmop.ca', body: 'IT WAS GREAT, thanks!' }).queue, 'google-reviews');
    assert.equal(sent({ to: 'someone@urbanmop.ca', subject: 'Action from CEL Visit Report #12' }).rule, 'Action from CEL Report route to Operations');
    // Email to info@ goes to Operations before the rules below "Operations Queue Rule", as in Kustomer.
    assert.equal(sent({ body: 'IT WAS GREAT, thanks!' }).rule, 'Operations Queue Rule');
  });

  test('Admin: the subject must have its words (Kustomer also checks the message, which here includes the subject)', () => {
    assert.equal(sent({ subject: 'Changes to Availability for Team 4', body: 'See the changes to availability for team 4' }).queue, 'admin');
    assert.equal(sent({ subject: 'Changes to Availability for Team 4', body: 'Nothing else' }).queue, 'admin');
    assert.notEqual(sent({ subject: 'Hello', body: 'my upcoming schedule' }).queue, 'admin', 'message words alone are not enough');
  });

  test('rules that are off in Kustomer stay off; the rest falls to the Default Queue', () => {
    assert.equal(sent({ subject: '1-3 Star Google Review for Jane' }).queue, 'operations', 'not Jose: that rule is off');
    assert.equal(sent({ from: 'accountservices@mailchimp.com', subject: 'Promo' }).queue, 'operations', 'not Sales: that rule is off');
    assert.equal(sent({ to: 'someone@urbanmop.ca', subject: 'Hi' }).queue, 'fallback');
    assert.equal(sent({ to: 'someone@urbanmop.ca', subject: 'Hi' }).rule, null);
  });

  test('rules kept from Kustomer business rules still run around the queue rules', () => {
    assert.equal(route(rules, ctx({ from: 'notifications@kustomerapp.com' })).action.mark_done, true);
    assert.equal(sent({ body: 'Derek for review: refund' }).queue, 'management');
    assert.deepEqual(sent({ channel: 'sms', to: UM.smsOttawa, roles: ['cleaner'], body: 'Running late' }), { queue: 'operations', rule: 'Cleaners to Operations', sla: 'cleaner' });
    assert.equal(sent({ channel: 'sms', to: UM.smsOttawa, body: 'Hi' }).rule, 'Ottawa SMS to Operations');
    assert.equal(sent({ channel: 'voice', to: UM.smsOttawa }).rule, 'Calls to Operations');
    // A cleaner's text to the hiring line is HR work, as in Kustomer's HR Queue Rule.
    assert.equal(sent({ channel: 'sms', to: UM.smsHiring, roles: ['cleaner'], body: 'More shifts?' }).queue, 'hr');
  });
});

describe('migration 0036: a database seeded before the Kustomer export', () => {
  const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });

  test('queues, rules and teams move to Kustomer; Hiring merges into HR; members, other teams and history are kept; agents are added', async () => {
    const db = await openDb({ migrate: false });
    await runMigrations(db, { migrations: loadMigrations().filter((m) => m.version < '0036') });
    const one = async (sql, p) => (await db.query(sql, p)).rows[0];
    const rows = async (sql, p) => (await db.query(sql, p)).rows;

    // The old seed's shape: a few of its queues, one rule, two of its default teams and a team of our own.
    await db.query("INSERT INTO agent_statuses (slug, name, kind) VALUES ('available','Available','available'), ('offline','Offline','offline')");
    await db.query(`INSERT INTO queues (slug, name, restricted, position) VALUES
      ('operations','Operations',false,0), ('sales','Sales',false,1), ('hr','HR',true,5), ('hiring','Hiring',true,6), ('fallback','Fallback',false,8)`);
    await db.query(`INSERT INTO routing_rules (position, name, conditions, action) VALUES (10, 'Other email to Operations', '{"channel":["email"]}', '{"queue":"operations"}')`);
    const ana = await one("INSERT INTO users (email, name, role) VALUES ('ana@example.com','Ana','admin') RETURNING id");
    const cy = await one("INSERT INTO users (email, name) VALUES ('cy@example.com','Cy') RETURNING id");
    const team = async (name, slugs) => {
      const t = await one('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name]);
      await db.query('INSERT INTO queue_teams (queue_id, team_id) SELECT id, $2 FROM queues WHERE slug = ANY($1::text[])', [slugs, t.id]);
      return t.id;
    };
    await db.query('INSERT INTO team_members VALUES ($1,$2)', [await team('Customer care', ['operations', 'fallback']), ana.id]);
    await db.query('INSERT INTO team_members VALUES ($1,$2)', [await team('People', ['hiring', 'hr']), cy.id]);
    await team('Weekend crew', ['operations']);
    const hiringConv = await one("INSERT INTO conversations (channel, queue_id) SELECT 'sms', id FROM queues WHERE slug = 'hiring' RETURNING id");

    assert.equal((await runMigrations(db))[0], '0036_kustomer_routing'); // later migrations run after it

    const queues = await rows('SELECT slug, name, restricted FROM queues ORDER BY position');
    assert.deepEqual(queues.slice(0, QUEUES.length).map((q) => q.slug), QUEUES.map((q) => q.slug));
    assert.equal(queues.find((q) => q.slug === 'operations').name, 'Operations Queue');
    assert.equal(queues.find((q) => q.slug === 'fallback').name, 'Default Queue');
    assert.equal(queues.find((q) => q.slug === 'hr').restricted, true);
    assert.ok(!queues.some((q) => q.slug === 'hiring'), 'Hiring is merged into HR Queue');
    assert.equal((await one('SELECT q.slug FROM conversations c JOIN queues q ON q.id = c.queue_id WHERE c.id = $1', [hiringConv.id])).slug, 'hr');

    const saved = await rows('SELECT * FROM routing_rules ORDER BY position');
    assert.equal(saved.length, 30);
    assert.equal(saved[0].name, 'System notices: mark done');
    assert.equal(saved.find((r) => r.name === 'Billing Routing').enabled, false);
    assert.equal(route(saved, ctx({ subject: 'Cart Abandonment: Jane' })).action.queue, 'sales-overflow');
    assert.equal(route(saved, ctx({ to: 'someone@urbanmop.ca' })).action.queue, 'fallback');
    const history = await one("SELECT detail FROM audit_log WHERE action = 'rules.replaced'");
    assert.deepEqual(history.detail.before.map((r) => r.name), ['Other email to Operations'], 'the old rules are in the change history');
    assert.deepEqual(history.detail.removed, ['Other email to Operations']);

    const teams = await rows(`SELECT t.name, COALESCE((SELECT array_agg(q.slug ORDER BY q.slug) FROM queue_teams qt JOIN queues q ON q.id = qt.queue_id WHERE qt.team_id = t.id), '{}') AS queues,
                                     COALESCE((SELECT array_agg(u.email ORDER BY u.email) FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id), '{}') AS members
                              FROM teams t ORDER BY t.position`);
    const byName = Object.fromEntries(teams.map((t) => [t.name, t]));
    for (const t of DEFAULT_TEAMS) assert.deepEqual(byName[t.name]?.queues, [...t.queues].sort(), `${t.name} works Kustomer's queues`);
    assert.deepEqual(byName['(8AM-6PM)Operations Team'].members, ['ana@example.com'], 'Customer care members carry over');
    assert.deepEqual(byName['Customer Success'].members, ['ana@example.com']);
    assert.deepEqual(byName['HR Team'].members, ['cy@example.com'], 'People members carry over');
    assert.ok(!byName['Customer care'] && !byName.People, 'the old default teams are gone');
    assert.deepEqual(byName['Weekend crew'].queues, ['operations'], 'teams of our own are left alone');
    assert.equal((await one("SELECT count(*)::int AS n FROM audit_log WHERE action = 'teams.replaced'")).n, 1);

    const added = await rows('SELECT email, role, active, status_id FROM users WHERE email = ANY($1::text[]) ORDER BY id', [NEW_AGENTS]);
    assert.deepEqual(added.map((u) => [u.email, u.role, u.active]), NEW_AGENTS.map((e) => [e, 'agent', true]));
    const offline = await one("SELECT id FROM agent_statuses WHERE slug = 'offline'");
    assert.ok(added.every((u) => Number(u.status_id) === Number(offline.id)), 'they start offline');
    assert.deepEqual(await runMigrations(db), [], 'runs once');

    // Admins can put the new agents on teams before they sign in; signing in keeps that.
    const mock = createMockLaunch27({ password: 'demo' });
    const config = loadConfig({ APP_ENV: 'development', L27_MODE: 'mock', MOCK_PASSWORD: 'demo' });
    const server = createApp(config, { db, fetchImpl: mock, log: quiet }).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const signIn = async (email) => (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo' }) })).headers.get('set-cookie').split(';')[0];
      const call = async (cookie, path, method = 'GET', body) => {
        const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: res.status === 204 ? null : await res.json() };
      };
      const admin = await signIn('ana@example.com');
      const wf = (await call(admin, '/api/admin/workforce')).body;
      const simon = wf.agents.find((a) => a.email === 'simon@urbanmop.ca');
      assert.ok(simon, 'listed under Agents before signing in');
      assert.ok(NEW_AGENTS.every((e) => wf.agents.some((a) => a.email === e)));
      const salesMaster = wf.teams.find((t) => t.name === 'Sales Master');
      assert.equal((await call(admin, `/api/users/${simon.id}`, 'PATCH', { team_ids: [salesMaster.id] })).status, 200);

      const me = (await call(await signIn('simon@urbanmop.ca'), '/api/me')).body;
      assert.equal(Number(me.id), Number(simon.id), 'signing in uses the added row');
      assert.equal(me.role, 'agent');
      assert.deepEqual(me.queues.map((q) => q.slug).sort(), ['sales', 'sales-overflow']);
    } finally {
      await new Promise((r) => server.close(r));
      await db.close();
    }
  });

  test('a new database is left to the seed: same queues, rules and teams, and nobody pre-added', async () => {
    const db = await openDb();
    try {
      assert.equal((await db.query('SELECT count(*)::int AS n FROM queues')).rows[0].n, 0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0, 'the first person to sign in still becomes admin');
      await seed(db);
      assert.deepEqual((await db.query('SELECT slug FROM queues ORDER BY position')).rows.map((q) => q.slug), QUEUES.map((q) => q.slug));
      assert.deepEqual((await db.query('SELECT name FROM routing_rules ORDER BY position')).rows.map((r) => r.name), RULES.map((r) => r.name));
      assert.deepEqual((await db.query('SELECT name FROM teams ORDER BY position')).rows.map((t) => t.name), DEFAULT_TEAMS.map((t) => t.name));
      assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE detail->>'source' LIKE '%migration 0036%'")).rows[0].n, 0);
    } finally {
      await db.close();
    }
  });
});
