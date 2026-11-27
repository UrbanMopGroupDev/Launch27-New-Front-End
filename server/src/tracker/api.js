// /api/tracker/*: the complaints tracker, and /api/adjustments: the Cleaner Adjustment form.
// Open to everyone on the team who is signed in, as Kustomer's were; loading from Kustomer
// is for admins.
import { cleanerTitle } from './service.js';

export function registerTrackerRoutes(r, { tracker, adjustments, needRole, wrap, l27 = null }) {
  const admin = needRole('admin');
  const h = (fn) =>
    wrap(async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    });
  const id = (req, name = 'id') => {
    const n = Number(req.params[name]);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('Bad id'), { status: 400 });
    return n;
  };
  // Launch27's cleaners, read with the signed-in user's session (cached by the client).
  const teamsFor = (req) => (l27?.teams && req.bearer ? () => l27.teams(req.bearer) : null);
  // A cleaner picked by id: the name stored is Launch27's, never one sent by the browser.
  async function withCleaner(req, body) {
    if (body.cleaner_id === undefined || body.cleaner_id === null || body.cleaner_id === '') return body;
    const teams = teamsFor(req);
    if (!teams) throw Object.assign(new Error('Launch27 cleaners are not available right now'), { status: 503 });
    const t = (await teams()).find((x) => Number(x.id) === Number(body.cleaner_id));
    if (!t) throw Object.assign(new Error('Cleaner: not found in Launch27'), { status: 400 });
    return { ...body, cleaner_id: Number(t.id), cleaner_name: cleanerTitle(t) };
  }
  const found = (res, value) => (value ? res.json(value) : res.status(404).json({ error: 'Not found' }));

  if (tracker) {
    r.get('/tracker/meta', h(async (req, res) => res.json(await tracker.meta())));
    r.get('/tracker/counts', h(async (req, res) => res.json(await tracker.counts())));
    r.get('/tracker/complaints', h(async (req, res) => res.json(await tracker.list({ view: req.query.view || 'overview', sort: req.query.sort || null, dir: req.query.dir || null, q: req.query.q || '' }))));
    r.post('/tracker/complaints', h(async (req, res) => {
      const out = await tracker.create(req.user, await withCleaner(req, req.body || {}));
      res.status(out.existing ? 200 : 201).json(out);
    }));
    r.post('/tracker/complaints/bulk', h(async (req, res) => res.json(await tracker.bulk(req.user, req.body?.ids, await withCleaner(req, req.body?.patch || {})))));
    r.get('/tracker/complaints/:id/guidance', h(async (req, res) => found(res, await tracker.guidance(id(req)))));
    r.get('/tracker/complaints/:id', h(async (req, res) => found(res, await tracker.get(id(req)))));
    r.patch('/tracker/complaints/:id', h(async (req, res) => found(res, await tracker.patch(req.user, id(req), await withCleaner(req, req.body || {})))));
    r.post('/tracker/complaints/:id/comments', h(async (req, res) => res.status(201).json(await tracker.comment(req.user, id(req), req.body?.body))));
    r.get('/tracker/conversations/:id', h(async (req, res) => res.json({ complaints: await tracker.forConversation(id(req)), positive: await tracker.positiveFor(id(req)) })));
    r.get('/tracker/contacts/:id/complaints', h(async (req, res) => res.json(await tracker.forContact(id(req)))));
    r.get('/tracker/positive-feedback', h(async (req, res) => res.json(await tracker.positiveList())));
    r.post('/tracker/positive-feedback/:id', h(async (req, res) => res.json({ positive: await tracker.positiveSet(req.user, id(req), req.body?.action) })));
    // Match names to records: staff names to logins, cleaner names to Launch27 cleaners.
    r.post('/tracker/link-names', admin, h(async (req, res) => {
      const teams = teamsFor(req);
      res.json(await tracker.linkNames(teams ? await teams() : null));
    }));
    r.get('/tracker/kustomer/load', h(async (req, res) => res.json(tracker.loadStatus())));
    r.post('/tracker/kustomer/load', admin, h(async (req, res) => res.status(202).json(tracker.startLoad(req.user, { days: req.body?.days, teams: teamsFor(req) }))));
  }
  if (adjustments) {
    r.get('/adjustments/meta', h(async (req, res) => res.json(adjustments.meta())));
    r.post('/adjustments', h(async (req, res) => res.status(201).json(await adjustments.submit(req.user, req.body || {}))));
  }
}
