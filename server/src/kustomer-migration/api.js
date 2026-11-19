// /api/admin/kustomer/*: the Kustomer migration page. Open to everyone on the team who is signed
// in (agents, supervisors and admins), whatever their queue access: exported records hold
// customers' messages, so the router's sign-in check still applies. The import routes write
// Kustomer history into the inbox (historical, closed conversations; nothing is sent).
export function registerKustomerRoutes(r, { migration, needRole, wrap }) {
  const team = needRole('agent', 'supervisor', 'admin'); // everyone on the team
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
  r.get('/admin/kustomer', team, h(async (req, res) => res.json(await migration.overview())));
  r.post('/admin/kustomer/test', team, h(async (req, res) => res.json(await migration.testConnection())));
  r.get('/admin/kustomer/scope', team, h(async (req, res) => res.json(await migration.scope())));
  r.post('/admin/kustomer/exports', team, h(async (req, res) => {
    const { kind = 'full', since = null, attachments = true } = req.body || {};
    res.status(201).json(await migration.startExport(req.user, { kind, since, attachments }));
  }));
  r.post('/admin/kustomer/exports/:id/:action', team, h(async (req, res) => res.json(await migration.exportAction(id(req), req.params.action))));
  r.post('/admin/kustomer/dry-runs', team, h(async (req, res) => res.status(201).json(await migration.startDryRun(req.user))));
  r.get('/admin/kustomer/matches', team, h(async (req, res) => res.json(await migration.matches({ match: req.query.match || null, limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0 }))));
  r.get('/admin/kustomer/customers/:kid/conversations', team, h(async (req, res) => res.json(await migration.conversations(String(req.params.kid)))));
  r.get('/admin/kustomer/report.csv', team, h(async (req, res) => {
    const rep = await migration.report();
    res.set('Content-Disposition', `attachment; filename="${rep.filename}"`).type('text/csv').send(rep.csv);
  }));
  r.post('/admin/kustomer/imports', team, h(async (req, res) => res.status(201).json(await migration.startImport(req.user))));
  r.post('/admin/kustomer/imports/:id/:action', team, h(async (req, res) => res.json(await migration.importAction(req.user, id(req), req.params.action))));
  r.post('/admin/kustomer/purge', team, h(async (req, res) => res.json(await migration.purge())));
}
