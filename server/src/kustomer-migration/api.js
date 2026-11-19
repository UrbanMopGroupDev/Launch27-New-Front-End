// /api/admin/kustomer/*: the Kustomer migration page. Admins only: exported records hold
// customers' messages. Nothing here imports into the live inbox.
export function registerKustomerRoutes(r, { migration, needRole, wrap }) {
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
  const id = (req) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('Bad id'), { status: 400 });
    return n;
  };
  r.get('/admin/kustomer', admin, h(async (req, res) => res.json(await migration.overview())));
  r.post('/admin/kustomer/test', admin, h(async (req, res) => res.json(await migration.testConnection())));
  r.get('/admin/kustomer/scope', admin, h(async (req, res) => res.json(await migration.scope())));
  r.post('/admin/kustomer/exports', admin, h(async (req, res) => {
    const { kind = 'full', since = null, attachments = true } = req.body || {};
    res.status(201).json(await migration.startExport(req.user, { kind, since, attachments }));
  }));
  r.post('/admin/kustomer/exports/:id/:action', admin, h(async (req, res) => res.json(await migration.exportAction(id(req), req.params.action))));
  r.post('/admin/kustomer/dry-runs', admin, h(async (req, res) => res.status(201).json(await migration.startDryRun(req.user))));
  r.get('/admin/kustomer/matches', admin, h(async (req, res) => res.json(await migration.matches({ match: req.query.match || null, limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0 }))));
  r.get('/admin/kustomer/customers/:kid/conversations', admin, h(async (req, res) => res.json(await migration.conversations(String(req.params.kid)))));
  r.get('/admin/kustomer/report.csv', admin, h(async (req, res) => {
    const rep = await migration.report();
    res.set('Content-Disposition', `attachment; filename="${rep.filename}"`).type('text/csv').send(rep.csv);
  }));
  r.post('/admin/kustomer/purge', admin, h(async (req, res) => res.json(await migration.purge())));
}
