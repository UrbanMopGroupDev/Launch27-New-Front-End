import express from 'express';
import cookieParser from 'cookie-parser';
import { SessionStore, COOKIE_MAX_AGE_MS } from './sessions.js';
import { createTracker } from './tracker/service.js';
import { createAdjustments } from './tracker/adjustments.js';
import { createInboxRouter } from './inbox/api.js';
import { tokenMatches } from './qa/service.js';
import { guardConnectors } from './inbox/channels.js';
import { createL27Client } from './inbox/lookup.js';
import { createLogger, requestLogger } from './log.js';
import { migrationStatus } from './db/migrate.js';
import { createPlacementRouter } from './placement/api.js';
import { canSeeUtilization } from './config.js';
import { canSeeKpi } from './kpi/service.js';

const COOKIE = 'l27_session';
const UPSTREAM_TIMEOUT_MS = 30_000;
// Request headers worth passing through to Launch27. Cookies and auth never are.
const FORWARD_HEADERS = ['accept', 'content-type'];

export function createApp(
  config,
  { fetchImpl = fetch, sessions = new SessionStore({ secret: config.sessionSecret }), db = null, connectors = {}, log = createLogger({ level: 'warn' }), jobs = null, qa = {}, segments = null, schedule = null, reports = null, writes = null, commercial = null, placement = null, commercialPlan = null, complaints = null, smsProviders = {}, kustomerMigration = null, kpi = null, tracker = null, adjustments = null } = {},
) {
  const app = express();
  // Behind Railway's (or any) HTTPS proxy: trust X-Forwarded-* so secure cookies work.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestLogger(log));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Liveness: the process is up. Never touches the database.
  // Also read by the sign-in page for its DEV / QA / PROD label and portal name.
  app.get('/healthz', (req, res) => res.json({ status: 'ok', env: config.appEnv, portal: config.portalName || 'UrbanMop', version: config.version, uptimeSec: Math.round(process.uptime()) }));

  // Readiness: can serve traffic (database reachable, migrations applied, worker healthy).
  // Railway's health check uses this, so a deploy only goes live when it passes.
  app.get('/readyz', async (req, res) => {
    const checks = { database: 'skipped', migrations: 'skipped', worker: 'skipped' };
    let ok = true;
    if (db) {
      try {
        await db.query('SELECT 1');
        checks.database = 'ok';
        const pending = (await migrationStatus(db)).filter((m) => m.state !== 'applied');
        checks.migrations = pending.length ? `pending: ${pending.map((m) => m.name).join(', ')}` : 'ok';
        if (pending.length) ok = false;
      } catch (err) {
        checks.database = 'unreachable';
        ok = false;
        log('error', 'readiness: database check failed', { error: err.message });
      }
    }
    if (jobs) {
      checks.worker = jobs.consecutiveFailures >= 5 ? `failing (${jobs.consecutiveFailures} in a row)` : 'ok';
      if (jobs.consecutiveFailures >= 5) ok = false;
    }
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', env: config.appEnv, version: config.version, l27: config.l27Mode, notifications: config.notificationsMode, checks });
  });

  app.use(cookieParser(config.sessionSecret));
  // Load a persisted session (after a redeploy) before any route reads it.
  app.use(async (req, res, next) => {
    const id = req.signedCookies?.[COOKIE];
    if (id) await sessions.hydrate?.(id).catch((err) => log('error', 'session hydrate failed', { error: err.message }));
    next();
  });

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    signed: true,
    maxAge: COOKIE_MAX_AGE_MS,
  };

  // Same login call the check-in tracker uses: POST /latest/login -> { bearer }.
  // Each user signs in with their own Launch27 account, so Launch27 keeps
  // enforcing their permissions.
  app.post('/auth/login', express.json(), async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    let upstream;
    try {
      upstream = await fetchImpl(`${config.l27BaseUrl}/latest/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      return res.status(502).json({ error: `Could not reach Launch27: ${err.message}` });
    }

    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !body.bearer) {
      return res.status(upstream.status >= 400 ? upstream.status : 401).json({ error: body.error || body.message || 'Login failed' });
    }

    res.cookie(COOKIE, sessions.create(body.bearer, email), cookieOptions);
    res.json({ email });
  });

  app.get('/auth/me', (req, res) => {
    const session = sessions.get(req.signedCookies[COOKIE]);
    if (!session) return res.status(401).json({ error: 'Not logged in' });
    const features = { utilization: canSeeUtilization(config, session.email), kpi: !!kpi && canSeeKpi(config, session.email) };
    res.json({ email: session.email, allowWrites: config.allowWrites, env: config.appEnv, l27Mode: config.l27Mode, notificationsMode: config.notificationsMode, features });
  });

  app.post('/auth/logout', (req, res) => {
    sessions.delete(req.signedCookies[COOKIE]);
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.status(204).end();
  });

  // Pass-through: /l27/v1/staff/bookings?from=... -> {L27_BASE_URL}/v1/staff/bookings?from=...
  // with the user's bearer token attached.
  app.use('/l27', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
    const session = sessions.get(req.signedCookies[COOKIE]);
    if (!session) return res.status(401).json({ error: 'Not logged in' });

    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const logWrite = (entry) => (isWrite && writes ? writes.record({ email: session.email, source: 'app screens', method: req.method, path: req.url, body: req.body, ...entry }) : Promise.resolve());
    if (isWrite && !config.allowWrites) {
      await logWrite({ outcome: 'blocked', status: 403 });
      return res.status(403).json({ error: config.production ? 'Writes to Launch27 are turned off (set L27_ALLOW_WRITES=true)' : `Writes to the live Launch27 are blocked in ${config.appEnv}` });
    }

    const headers = { authorization: `Bearer ${session.bearer}` };
    for (const name of FORWARD_HEADERS) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }

    let upstream;
    try {
      upstream = await fetchImpl(`${config.l27BaseUrl}${req.url}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) || !req.body?.length ? undefined : req.body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      await logWrite({ outcome: 'failed', error: err.message });
      return res.status(502).json({ error: `Could not reach Launch27: ${err.message}` });
    }

    // Launch27 rejected the token (expired or revoked): end our session too so
    // the UI sends the user back to the login screen.
    if (upstream.status === 401) sessions.delete(req.signedCookies[COOKIE]);

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.type(contentType);
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (isWrite) await logWrite({ outcome: upstream.ok ? 'done' : 'refused', status: upstream.status, error: upstream.ok ? null : buf.toString('utf8').slice(0, 500) });
    res.send(buf);
    // A booking made, changed or cancelled here: recalculate that customer's segment now.
    if (schedule && upstream.ok && req.method !== 'GET' && req.path.startsWith('/v1/staff/bookings')) schedule.soon(session.bearer);
    if (segments && upstream.ok && req.method !== 'GET' && req.path.startsWith('/v1/staff/bookings')) {
      refreshAfterWrite(session.bearer, req.path, buf).catch((err) => log.warn('segment refresh after booking change failed', { error: err.message }));
    }
  });

  async function refreshAfterWrite(bearer, pathName, buf) {
    let body = null;
    try {
      body = JSON.parse(buf.toString('utf8'));
    } catch {
      body = null;
    }
    let cid = body?.user?.id ?? body?.customer_id ?? null;
    const id = pathName.match(/^\/v1\/staff\/bookings\/(\d+)/)?.[1];
    if (!cid && id) {
      const res = await fetchImpl(`${config.l27BaseUrl}/v1/staff/bookings/${id}`, { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (res.ok) cid = (await res.json())?.user?.id ?? null;
    }
    if (cid) await segments.refreshCustomer(bearer, cid);
  }

  // SMS webhooks (no session: Twilio calls them), signed with the Auth Token (X-Twilio-Signature).
  if (smsProviders.twilio) {
    app.post('/webhooks/twilio/sms', express.urlencoded({ extended: false, limit: '256kb' }), (req, res, next) => smsProviders.twilio.handleWebhook(req, res).catch(next));
    app.post('/webhooks/twilio/status', express.urlencoded({ extended: false, limit: '64kb' }), (req, res, next) => smsProviders.twilio.handleStatus(req, res).catch(next));
  }

  // QA only: receive the copy of production data (contact details masked) from production.
  if (config.qaSnapshotReceive && qa.store) {
    app.put('/qa/snapshot', express.json({ limit: '300mb' }), async (req, res) => {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(auth, config.qaSnapshotToken)) return res.status(401).json({ error: 'Not allowed' });
      try {
        const summary = await qa.store.save(req.body);
        res.json({ summary });
      } catch (err) {
        log.warn('QA copy refused', { error: err.message });
        res.status(422).json({ error: err.message });
      }
    });
  }

  // The company analytics dashboard reads daily field-operations counts here (docs/analytics-feed.md).
  // Off unless ANALYTICS_FEED_KEY (24+ characters) is set; the caller sends it as a Bearer token.
  // Counts only: no customer names, addresses or cleaner pay.
  const feedKey = process.env.ANALYTICS_FEED_KEY || '';
  app.get('/analytics/v1/field', async (req, res, next) => {
    try {
      if (!feedKey || feedKey.length < 24 || !reports?.fieldFeed) return res.status(404).json({ error: 'Not found.' });
      if (!tokenMatches(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''), feedKey)) return res.status(401).json({ error: 'Not allowed.' });
      res.set('Cache-Control', 'no-store').json(await reports.fieldFeed({ from: req.query.from, to: req.query.to }));
    } catch (e) { if (e.status === 409) return res.status(409).json({ error: e.message }); next(e); }
  });
  // The same numbers as a catalogue of datasets, the contract every app follows for the company
  // dashboard (docs/analytics-feed.md): the middleware copies each dataset to its own sheet tab.
  const FEED_DATASETS = [
    { name: 'field_daily', title: 'Field operations by day', kind: 'period', grain: 'day × location × area × cleaner × client type', description: 'Cleaner visits, same cleaner for recurring clients, on-time arrival, minutes late, visits that ran long, en route texts, km driven, ratings and revenue.', pick: (f) => ({ from: f.from, to: f.to, columns: f.columns, rows: f.rows }) },
    { name: 'capacity', title: 'Hours filled by area, next four weeks', kind: 'snapshot', grain: 'one row per area', description: 'Assignable cleaners, booked and available hours per week, and visits with no cleaner yet.', pick: (f) => ({ columns: f.capacity_columns, rows: f.capacity }) },
    { name: 'planner', title: 'Schedule changes to handle', kind: 'snapshot', grain: 'one row (last four weeks)', description: 'Changes the planner raised, how many were handled, how fast, and how many are still open.', pick: (f) => { const c = ['raised', 'handled', 'handled_share', 'median_hours', 'recommended_share', 'expired', 'open', 'snapshot_taken_at']; return { columns: c, rows: [c.map((k) => (k === 'snapshot_taken_at' ? f.taken_at : f.planner?.[k]) ?? null)] }; } },
  ];
  let feedCache = null;
  const feedOf = async (from, to) => {
    const key = `${from || ''}|${to || ''}`;
    if (!feedCache || feedCache.key !== key || Date.now() - feedCache.at > 10 * 60_000) feedCache = { key, at: Date.now(), out: await reports.fieldFeed({ from, to }) };
    return feedCache.out;
  };
  const feedRoute = (handler) => async (req, res, next) => {
    try {
      if (!feedKey || feedKey.length < 24 || !reports?.fieldFeed) return res.status(404).json({ error: 'Not found.' });
      if (!tokenMatches(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''), feedKey)) return res.status(401).json({ error: 'Not allowed.' });
      const out = await handler(req);
      if (!out) return res.status(404).json({ error: 'No such dataset.' });
      res.set('Cache-Control', 'no-store').json(out);
    } catch (e) { if (e.status === 409) return res.status(409).json({ error: e.message }); next(e); }
  };
  app.get('/analytics/v1/catalogue', feedRoute(async () => ({ source: 'residential', version: 1, time_zone: 'America/Toronto', default_window_days: 730,
    datasets: FEED_DATASETS.map(({ pick: _p, ...d }) => ({ ...d, path: `/analytics/v1/data/${d.name}` })) })));
  app.get('/analytics/v1/data/:name', feedRoute(async (req) => {
    const d = FEED_DATASETS.find((x) => x.name === req.params.name);
    if (!d) return null;
    const f = await feedOf(d.kind === 'period' ? req.query.from : null, d.kind === 'period' ? req.query.to : null);
    return { name: d.name, kind: d.kind, generated_at: new Date().toISOString(), from: null, to: null, ...d.pick(f) };
  }));

  // Placement API for the Sales Hub (service tokens, not staff logins). Mounted before the
  // workspace's /api routes, which need a signed-in person.
  if (placement && config.placementTokens?.size) app.use('/api/placement/v1', createPlacementRouter({ placement, config, log, limits: config.placementLimits }));

  // The support workspace (conversations, contacts, routing). Needs a database.
  if (db) {
    const l27 = createL27Client({ baseUrl: config.l27BaseUrl, fetchImpl });
    app.use('/api', createInboxRouter({ db, sessions, cookieName: COOKIE, config, l27, connectors: guardConnectors(connectors, config.notificationsMode), log, qa, segments, schedule, reports, writes, commercial, placement, commercialPlan, complaints, smsProviders, kustomerMigration, kpi, tracker: tracker || createTracker({ db, config, fetchImpl, log }), adjustments: adjustments || createAdjustments({ db, config, fetchImpl, log }) }));
  }

  // Last-resort error handler: log it (without personal data), answer generically.
  app.use((err, req, res, next) => {
    log('error', 'unhandled request error', { path: req.path, error: err.message, stack: err.stack });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return app;
}
