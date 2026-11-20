// /api/complaints/*: the Phase 1 playbook, cases and rules. Complaint cases hold client
// names and what they wrote, so reading is supervisors and admins only; starting a run,
// Kustomer discovery and changing the rules are admins only.
import { CATEGORY_KEYS, HARD_ROUTES } from './taxonomy.js';
import { APPROVAL_PRESETS, RUNGS } from './settings.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function registerComplaintRoutes(r, { complaints, needRole, wrap, now = () => Date.now() }) {
  const lead = needRole('supervisor', 'admin');
  const admin = needRole('admin');
  const h = (fn) => wrap(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });
  const windowOf = async (req) => {
    const months = (await complaints.getSettings()).pilot_months;
    const to = DAY.test(req.query.to || '') ? req.query.to : isoDay(now() - 86_400_000);
    const from = DAY.test(req.query.from || '') ? req.query.from : isoDay(Date.parse(to) - months * 30.44 * 86_400_000);
    return { from, to };
  };

  r.get('/complaints/status', lead, h(async (req, res) => {
    // Opening the page is what keeps it up to date where there's no overnight Launch27 login:
    // start today's update (or the next older month) in the background with this person's login.
    complaints.maybeRun({ bearer: req.bearer }).catch(() => {});
    res.json({ ...(await complaints.status()), window: await windowOf(req) });
  }));
  r.get('/complaints/playbook', lead, h(async (req, res) => res.json(await complaints.playbook(await windowOf(req)))));
  r.get('/complaints/cases', lead, h(async (req, res) => {
    const w = await windowOf(req);
    const category = CATEGORY_KEYS.includes(req.query.category) ? req.query.category : null;
    res.json(await complaints.listCases({ ...w, category }));
  }));
  r.get('/complaints/cases/:id', lead, h(async (req, res) => {
    const c = await complaints.getCase(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  }));
  r.patch('/complaints/cases/:id', lead, h(async (req, res) => {
    const { category, hard_route } = req.body || {};
    if (category && !CATEGORY_KEYS.includes(category)) return res.status(400).json({ error: 'Unknown category' });
    if (hard_route && !HARD_ROUTES[hard_route]) return res.status(400).json({ error: 'Unknown hard route' });
    await complaints.setCategory(Number(req.params.id), { category, hard_route }, req.user.id);
    res.json(await complaints.getCase(Number(req.params.id)));
  }));
  r.get('/complaints/review', lead, h(async (req, res) => {
    const category = CATEGORY_KEYS.includes(req.query.category) ? req.query.category : null;
    const source = /^[a-z0-9_]{2,30}$/.test(req.query.source || '') ? req.query.source : null;
    const [queue, stats] = await Promise.all([complaints.reviewQueue({ per: Number(req.query.per) || 20, category, source }), complaints.reviewStats()]);
    res.json({ queue, stats });
  }));
  r.post('/complaints/cases/:id/review', lead, h(async (req, res) => {
    const { verdict, category, note } = req.body || {};
    if (!['correct', 'wrong_category', 'not_complaint'].includes(verdict)) return res.status(400).json({ error: 'Unknown verdict' });
    if (verdict === 'wrong_category' && !CATEGORY_KEYS.includes(category)) return res.status(400).json({ error: 'Pick the right category' });
    await complaints.reviewCase(Number(req.params.id), { verdict, category, note }, req.user.id);
    res.json({ ok: true, stats: await complaints.reviewStats() });
  }));
  r.get('/complaints/clients', lead, h(async (req, res) => res.json(await complaints.clients())));
  r.post('/complaints/run', admin, h(async (req, res) => {
    const w = { from: DAY.test(req.body?.from || '') ? req.body.from : null, to: DAY.test(req.body?.to || '') ? req.body.to : null };
    const def = await windowOf({ query: {} });
    res.status(202).json(complaints.start({ from: w.from || def.from, to: w.to || def.to, userId: req.user.id, bearer: req.bearer }));
  }));
  r.get('/complaints/kustomer/discover', admin, h(async (req, res) => res.json(await complaints.kustomerDiscover())));
  r.get('/complaints/settings', lead, h(async (req, res) => res.json({ settings: await complaints.getSettings(), rungs: RUNGS, presets: APPROVAL_PRESETS, categories: CATEGORY_KEYS, hard_routes: HARD_ROUTES })));
  r.put('/complaints/settings', admin, h(async (req, res) => res.json({ settings: await complaints.saveSettings(req.body || {}, req.user.id) })));
}
