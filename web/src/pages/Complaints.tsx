// Complaint playbook (Phase 1 of the Complaint Resolution Engine, Residential only).
// Playbook: what complaints we get, what we did, what kept clients and at what cost.
// Cases: every mined case with its journey, resolution, cost and outcome.
// Rules: the ladder, who approves what, the refund budget and cost assumptions.
// Supervisors and admins only (cases hold client names and what they wrote).
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useInboxMe } from '../inbox/util';
import { complaintsApi, OUTCOME_LABEL, SOURCE_LABEL, TONE_LABEL, type CaseRow, type Confidence, type OutcomeStats, type Playbook, type Settings, type Status } from '../complaints/api';
import { Kpi } from '../reports/ui';
import { money, pct } from '../reports/api';

const CATEGORY_LABEL: Record<string, string> = {
  quality_missed: 'Quality: missed areas',
  quality_rushed: 'Quality: rushed / short time',
  punctuality: 'Late / no-show',
  cleaner_change: 'Cleaner change / consistency',
  scope_booking: 'Scope / booking error',
  communication: 'Communication',
  pricing_billing: 'Pricing / billing',
  property_condition: 'Property condition',
  damage: 'Damage / breakage',
  missing_item: 'Missing item / theft',
  conduct_safety: 'Cleaner conduct / safety',
  other: 'Other / unclear',
};
const catLabel = (k: string) => CATEGORY_LABEL[k] || k;
const conf = (c: Confidence, n: number) => <span className={`pill ${c === 'thin' || c === 'none' ? 'late' : ''}`} title={`${n} cases with a 60-day outcome`}>{c === 'none' ? 'no data' : `${c} · n=${n}`}</span>;
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export function ComplaintsPage() {
  const me = useInboxMe();
  const [tab, setTab] = useState<'playbook' | 'cases' | 'rules'>('playbook');
  const status = useQuery({ queryKey: ['complaints', 'status'], queryFn: complaintsApi.status, refetchInterval: (q) => (q.state.data?.running ? 5000 : false), retry: false });
  const isAdmin = me.data?.role === 'admin';
  if (status.isError) {
    return (
      <div className="seg-page">
        <section className="card seg-empty">
          <h2>Complaint playbook isn't available</h2>
          <p className="muted">{(status.error as Error).message}. It's open to supervisors and admins.</p>
        </section>
      </div>
    );
  }
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Support · Residential</span>
          <h1>Complaint playbook</h1>
          <p className="muted">What our complaints are, what we did, and what actually kept clients at what cost. Phase 1: learning from history. Nothing here sends anything.</p>
        </div>
      </header>
      {status.data && <RunBar status={status.data} isAdmin={isAdmin} />}
      <div className="tabs" role="tablist">
        {(['playbook', 'cases', 'rules'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'playbook' ? 'Playbook' : t === 'cases' ? 'Cases' : 'Rules & budget'}
          </button>
        ))}
      </div>
      {tab === 'playbook' && <PlaybookTab />}
      {tab === 'cases' && <CasesTab />}
      {tab === 'rules' && <RulesTab canEdit={isAdmin} />}
    </div>
  );
}

const RUN_LABEL: Record<string, { text: string; cls: string }> = {
  running: { text: 'Running', cls: '' },
  done: { text: 'Finished', cls: 'ok' },
  partial: { text: 'Finished with problems', cls: 'warn' },
  failed: { text: 'Failed', cls: 'neg' },
  interrupted: { text: 'Interrupted (the app restarted): run again for the rest', cls: 'warn' },
};
const clock = (s: string) => new Date(s).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });

function RunBar({ status, isAdmin }: { status: Status; isAdmin: boolean }) {
  const qc = useQueryClient();
  const run = useMutation({ mutationFn: () => complaintsApi.run(), onSuccess: () => qc.invalidateQueries({ queryKey: ['complaints'] }) });
  const last = status.last_run;
  useEffect(() => {
    if (!status.running) qc.invalidateQueries({ queryKey: ['complaints', 'playbook'] });
  }, [status.running, qc]);
  const state = status.running ? 'running' : last?.status || null;
  const problems = (last?.log || []).filter((l) => l.level === 'error' || l.level === 'warn');
  const latest = last?.log?.[last.log.length - 1];
  return (
    <section className="card">
      <div className="cmp-runbar">
        <div>
          <b>Window:</b> {day(status.window.from)} – {day(status.window.to)}
        </div>
        {isAdmin && (
          <button disabled={status.running || run.isPending} onClick={() => run.mutate()}>
            {status.running || run.isPending ? 'Running…' : last ? 'Run again' : 'Run the pilot'}
          </button>
        )}
      </div>
      {run.isError && <p className="neg small">Couldn't start the run: {(run.error as Error).message}</p>}
      {state && last && (
        <div className={`cmp-runstate ${RUN_LABEL[state]?.cls || ''}`} role="status" aria-live="polite">
          <b>{RUN_LABEL[state]?.text || state}</b>
          {status.running ? (
            <span> · started {clock(last.started_at)}{latest ? ` · ${latest.msg}` : ' · starting…'} · the first run takes 5–10 minutes</span>
          ) : (
            <span> · {day(last.started_at)} {clock(last.started_at)}{last.finished_at ? `–${clock(last.finished_at)}` : ''}</span>
          )}
        </div>
      )}
      {!status.running && problems.length > 0 && (
        <ul className="small cmp-problems">{problems.map((l, i) => <li key={i} className={l.level === 'error' ? 'neg' : 'warn'}>{l.msg}</li>)}</ul>
      )}
      <ul className="cmp-sources small">
        {Object.entries(status.sources).map(([k, v]) => (
          <li key={k}>
            <span className={`dot ${/connected|on|synthetic/.test(v) && !/not /.test(v) ? 'ok' : 'warn'}`} />
            <b>{k === 'claude' ? 'Claude classification' : k[0].toUpperCase() + k.slice(1)}</b>: {v}
          </li>
        ))}
      </ul>
      {last?.log?.length ? (
        <details className="small" open={status.running}>
          <summary>Run log ({last.log.length} steps)</summary>
          <ul>{last.log.map((l, i) => <li key={i} className={l.level === 'error' ? 'neg' : l.level === 'warn' ? 'warn' : ''}>{clock(l.at)} · {l.msg}</li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}

function StatCells({ s }: { s: OutcomeStats }) {
  return (
    <>
      <td>{s.n}</td>
      <td>{pct(s.saved)}</td>
      <td>{pct(s.lost)}</td>
      <td>{money(s.avg_cost)}</td>
      <td>{conf(s.confidence, s.decided)}</td>
    </>
  );
}

function PlaybookTab() {
  const q = useQuery({ queryKey: ['complaints', 'playbook'], queryFn: () => complaintsApi.playbook(), retry: false });
  const p = q.data;
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError) return <div className="error">{(q.error as Error).message}</div>;
  if (!p) return null;
  if (!p.totals.cases) return <section className="card seg-empty"><h2>No cases yet</h2><p className="muted">Run the pilot to mine the last {p.window.from ? 'six months' : 'months'} of complaints.</p></section>;
  return (
    <>
      <div className="tiles">
        <Kpi label="Complaint cases" value={String(p.totals.cases)} note={Object.entries(p.totals.by_source).map(([k, v]) => `${SOURCE_LABEL[k] || k} ${v}`).join(' · ')} />
        <Kpi label="Kept the client (60 days)" value={pct(p.totals.saved)} note={`of ${p.totals.decided} with a known outcome`} />
        <Kpi label="Lost the client" value={pct(p.totals.lost)} tone={(p.totals.lost || 0) > 0.3 ? 'warn' : undefined} />
        <Kpi label="Total cost" value={money(p.totals.total_cost)} note={`avg ${money(p.totals.avg_cost)} per case`} />
        <Kpi label="Hard-routed" value={String(p.totals.hard_routed)} note="damage >$100, theft, safety, misconduct, legal" />
        <Kpi label="First reply (median)" value={p.response.first_response_median_hours == null ? '—' : `${p.response.first_response_median_hours} h`} note={`${p.response.with_response_time} cases with reply times`} />
      </div>

      <section className="card">
        <h2>Taxonomy: what comes up, what we did, what worked</h2>
        <p className="muted small">"Cheapest that works" is the lowest-cost rung whose save rate is within 10 points of the best rung, among rungs with at least 3 decided cases. Anything marked thin rests on fewer than {p.thin_threshold} cases.</p>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Category</th><th>Share</th><th>We usually</th><th>Cases</th><th>Saved</th><th>Lost</th><th>Avg cost</th><th>Confidence</th><th>Cheapest that works</th></tr></thead>
            <tbody>
              {p.taxonomy.map((t) => (
                <tr key={t.key} className="static">
                  <td>{catLabel(t.key)}{t.hard_routed ? <span className="pill late">{t.hard_routed} hard-routed</span> : null}</td>
                  <td>{pct(t.share)}</td>
                  <td>{t.typical_rung || '—'}</td>
                  <StatCells s={t} />
                  <td>{t.cheapest_that_works ? `${t.cheapest_that_works.rung} · ${pct(t.cheapest_that_works.saved)} saved · ${money(t.cheapest_that_works.avg_cost)}` : <span className="muted">not enough data</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>The ladder: retention and real cost per rung</h2>
        <p className="muted small">Each case is counted at the highest rung it reached. Hard-routed cases are left out (they're never on the ladder). Reclean cost includes the cleaner's pay, travel and the margin of the slot it used up.</p>
        <table>
          <thead><tr><th>Rung</th><th>Action</th><th>Cases</th><th>Saved</th><th>Lost</th><th>Avg cost</th><th>Confidence</th></tr></thead>
          <tbody>
            {p.ladder.map((r) => (
              <tr key={r.rung} className="static"><td><b>{r.rung}</b> <span className="muted small">{r.tier}</span></td><td>{r.label}</td><StatCells s={r} /></tr>
            ))}
          </tbody>
        </table>
      </section>

      {p.reclean_vs_refund.length > 0 && (
        <section className="card">
          <h2>Reclean vs refund: where our default helped, where it was overkill</h2>
          <table>
            <thead><tr><th>Category</th><th>Reclean</th><th>Refund</th><th>Neither</th><th>Read</th></tr></thead>
            <tbody>
              {p.reclean_vs_refund.map((x) => (
                <tr key={x.key} className="static">
                  <td>{catLabel(x.key)}</td>
                  {[x.reclean, x.refund, x.neither].map((s, i) => <td key={i}>{s.n ? `${pct(s.saved)} saved · ${money(s.avg_cost)} · n=${s.decided}` : '—'}</td>)}
                  <td>{x.verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {p.root_causes && <RootCauses rc={p.root_causes} />}
      <Baseline b={p.baseline} />

      <section className="card">
        <h2>Data gaps and confidence</h2>
        <ul>{p.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
      </section>
    </>
  );
}

function RootCauses({ rc }: { rc: NonNullable<Playbook['root_causes']> }) {
  return (
    <section className="card">
      <h2>Pain points upstream: when complaints happen</h2>
      <p className="muted small">Complaints per 100 visits in each situation, against the overall {rc.base_rate_per_100} per 100 ({rc.linked_complaints} complaints linked to one of {rc.visits.toLocaleString()} visits). Above 1.5× is worth fixing before the complaint happens.</p>
      <table>
        <thead><tr><th>Situation at the visit</th><th>Visits</th><th>Complaints</th><th>Per 100</th><th>vs overall</th><th>Confidence</th></tr></thead>
        <tbody>
          {rc.rows.map((r) => (
            <tr key={r.key} className="static">
              <td>{r.label}</td><td>{r.visits.toLocaleString()}</td><td>{r.complaints}</td><td>{r.rate_per_100 ?? '—'}</td>
              <td className={(r.vs_base || 0) >= 1.5 ? 'neg' : ''}>{r.vs_base == null ? '—' : `${r.vs_base}×`}</td>
              <td>{conf(r.confidence, r.complaints)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Baseline({ b }: { b: Playbook['baseline'] }) {
  const max = Math.max(0.0001, ...b.months.map((m) => m.rate || 0));
  return (
    <section className="card">
      <h2>Refund budget baseline: complaint cost as a % of Residential revenue</h2>
      <p className="muted small">Refunds + credits + recleans, by month. Average {pct(b.average, 2)} · best {b.best ? `${b.best.month} ${pct(b.best.rate, 2)}` : '—'} · worst {b.worst ? `${b.worst.month} ${pct(b.worst.rate, 2)}` : '—'} · default target {pct(b.default_target, 2)} (20% below average).</p>
      <div className="cmp-bars" role="img" aria-label="Monthly complaint cost as a share of revenue">
        {b.months.map((m) => (
          <div key={m.month} className="cmp-bar" title={`${m.month}: ${pct(m.rate, 2)} (${money(m.cost)} of ${money(m.revenue)}, ${m.cases} cases)`}>
            <span style={{ height: `${((m.rate || 0) / max) * 100}%` }} />
            <small>{m.month.slice(5)}</small>
          </div>
        ))}
      </div>
      <p className="small warn">{b.caveat}</p>
    </section>
  );
}

function CasesTab() {
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['complaints', 'cases', category], queryFn: () => complaintsApi.cases({ category: category || undefined }), retry: false });
  const rows = q.data || [];
  const cats = useMemo(() => Object.keys(CATEGORY_LABEL), []);
  return (
    <div className="cmp-cases">
      <section className="card no-pad">
        <div className="cmp-filter">
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {cats.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
          </select>
          <span className="muted small">{rows.length} cases</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Opened</th><th>Client</th><th>Category</th><th>Tone</th><th>What we did</th><th>Cost</th><th>60 days</th><th>From</th></tr></thead>
            <tbody>
              {rows.map((c: CaseRow) => (
                <tr key={c.id} className={open === c.id ? 'selected' : ''} onClick={() => setOpen(c.id)}>
                  <td>{day(c.opened_at)}</td>
                  <td>{c.customer_name || <span className="muted">unmatched</span>}</td>
                  <td>{catLabel(c.category)}{c.hard_route && <span className="pill late">hard route</span>}</td>
                  <td>{c.tone ? TONE_LABEL[c.tone] : '—'}</td>
                  <td>{c.rungs || 'L0'}</td>
                  <td>{money(Number(c.total_cost))}</td>
                  <td>{c.outcome_60 ? OUTCOME_LABEL[c.outcome_60] : '—'}</td>
                  <td className="small muted">{SOURCE_LABEL[c.source] || c.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {open && <CaseDetailCard id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CaseDetailCard({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['complaints', 'case', id], queryFn: () => complaintsApi.case(id) });
  const fix = useMutation({ mutationFn: (category: string) => complaintsApi.reclassify(id, { category }), onSuccess: () => qc.invalidateQueries({ queryKey: ['complaints'] }) });
  const c = q.data;
  if (!c) return <section className="card">Loading…</section>;
  const j = c.journey;
  return (
    <section className="card cmp-detail">
      <div className="cmp-runbar"><h2>{c.customer_name || 'Unmatched client'} · {day(c.opened_at)}</h2><button className="link" onClick={onClose}>Close</button></div>
      {c.summary && <p>{c.summary}</p>}
      <dl className="kv">
        <dt>Category</dt>
        <dd>
          <select value={c.category} onChange={(e) => fix.mutate(e.target.value)} aria-label="Category">
            {Object.keys(CATEGORY_LABEL).map((k) => <option key={k} value={k}>{catLabel(k)}</option>)}
          </select>{' '}
          <span className="muted small">classified by {c.classified_by}</span>
        </dd>
        <dt>Tone · severity</dt><dd>{c.tone ? TONE_LABEL[c.tone] : '—'} · {c.severity ?? '—'}/4</dd>
        {c.hard_route && (<><dt>Hard route</dt><dd className="neg">{c.hard_route.replace(/_/g, ' ')} → Office Manager</dd></>)}
        <dt>Areas</dt><dd>{c.areas_cited?.length ? c.areas_cited.join(', ') : '—'}</dd>
        <dt>Booking</dt><dd>{c.l27_booking_id ? `#${c.l27_booking_id}` : '—'} {c.service_date && `· cleaned ${day(c.service_date)}`}</dd>
        {c.source_status && (<><dt>Kustomer status</dt><dd>{c.source_status}</dd></>)}
        {c.also_seen_in.length > 0 && (<><dt>Also seen in</dt><dd>{c.also_seen_in.map((d) => SOURCE_LABEL[d.source] || d.source).join(', ')}</dd></>)}
      </dl>
      {j && (
        <>
          <h3>Before the complaint</h3>
          <dl className="kv">
            <dt>Client</dt><dd>{j.tenure_days ?? '—'} days · {j.cleans_total} cleans · {String(j.frequency || '—')} · {money(Number(j.spend_12m))} in 12 months</dd>
            <dt>Cleaner</dt><dd>{String(j.cleaner_name || '—')} ({j.cleaner_visits_before ?? '?'} visits before){j.cleaner_changed_last_visit ? ' · different from the visit before' : ''} · {j.distinct_cleaners_90d} {Number(j.distinct_cleaners_90d) === 1 ? 'cleaner' : 'cleaners'} in 90 days</dd>
            <dt>Signals</dt><dd>{j.prior_complaints} earlier {Number(j.prior_complaints) === 1 ? 'complaint' : 'complaints'} · {j.prior_unhappy_ratings} earlier unhappy {Number(j.prior_unhappy_ratings) === 1 ? 'rating' : 'ratings'} · {j.price_change_pct != null ? `price ${Number(j.price_change_pct) > 0 ? '+' : ''}${pct(Number(j.price_change_pct))}` : 'no price history'} · {j.days_since_last_clean ?? '—'} days since last clean</dd>
          </dl>
        </>
      )}
      <h3>What we did</h3>
      {c.resolutions.length ? (
        <ul>{c.resolutions.map((r, i) => <li key={i}><b>{r.rung || r.action}</b> {r.action.replace(/_/g, ' ')}{r.pct != null ? ` ${r.pct}%` : ''}{r.amount ? ` ${money(Number(r.amount))}` : ''}{r.decided_by ? ` · decided by ${r.decided_by}` : ''}{r.approved_by && r.approved_by !== r.decided_by ? ` · approved by ${r.approved_by}` : ''} <span className="muted small">({SOURCE_LABEL[r.source] || r.source})</span></li>)}</ul>
      ) : <p className="muted">No compensation found (L0: apology only, or not recorded).</p>}
      <h3>Cost</h3>
      {c.costs.length ? <ul>{c.costs.map((k, i) => <li key={i}>{k.kind.replace(/_/g, ' ')}: {money(Number(k.amount))}{k.estimated ? <span className="muted small"> (estimated)</span> : ''}</li>)}</ul> : <p className="muted">$0</p>}
      <h3>Outcome</h3>
      <p>{c.outcomes.length ? c.outcomes.map((o) => `${o.day} days: ${OUTCOME_LABEL[o.outcome]}`).join(' · ') : 'Not linked to a Launch27 client, so no outcome.'}</p>
    </section>
  );
}

function RulesTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['complaints', 'settings'], queryFn: complaintsApi.settings });
  const pb = useQuery({ queryKey: ['complaints', 'playbook'], queryFn: () => complaintsApi.playbook(), retry: false });
  const users = useQuery({ queryKey: ['inbox', 'users'], queryFn: async () => (await fetch('/api/users', { credentials: 'same-origin' })).json() as Promise<{ email: string; name: string | null }[]> });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data && !s) setS(q.data.settings);
  }, [q.data, s]);
  const save = useMutation({ mutationFn: (x: Settings) => complaintsApi.saveSettings(x), onSuccess: (r) => { setS(r.settings); qc.invalidateQueries({ queryKey: ['complaints'] }); } });
  if (!q.data || !s) return <p className="muted">Loading…</p>;
  const base = pb.data?.baseline;
  const target = s.budget.target_pct ?? base?.default_target ?? null;
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  return (
    <fieldset disabled={!canEdit} className="cmp-rules">
      {!canEdit && <p className="muted small">Only admins can change these.</p>}
      <section className="card">
        <h2>Who approves what</h2>
        <label>Setup{' '}
          <select value={s.approval_preset} onChange={(e) => { const preset = e.target.value as Settings['approval_preset']; set({ approval_preset: preset, max_rung: {} }); }}>
            {Object.entries(q.data.presets).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <table>
          <thead><tr><th>Role</th><th>Can approve up to</th></tr></thead>
          <tbody>
            {Object.entries(s.max_rung).map(([role, rung]) => (
              <tr key={role} className="static"><td>{role.replace('_', ' ')}</td><td>{rung} · {q.data.rungs.find((r) => r.rung === rung)?.label}{role === 'owner' ? ' (only the owner can approve above 50%)' : ''}</td></tr>
            ))}
          </tbody>
        </table>
        <h3>Roles</h3>
        <p className="muted small">Everyone not listed is frontline. Office Manager is a role, so hard-routed cases follow whoever holds it.</p>
        <table>
          <tbody>
            {(users.data || []).map((u) => (
              <tr key={u.email} className="static">
                <td>{u.name || u.email}</td>
                <td>
                  <select value={s.roles[u.email.toLowerCase()] || 'frontline'} onChange={(e) => set({ roles: { ...s.roles, [u.email.toLowerCase()]: e.target.value } })}>
                    {['frontline', 'office_manager', 'gm', 'owner'].map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Refund budget</h2>
        <p className="muted small">Month-to-date refunds + credits + recleans as a share of month-to-date Residential revenue. Amber at 80% of target, red at 100% (banner + Slack DM to the owner). Frontline is never blocked, only flagged.</p>
        <label className="cmp-slider">
          Target: <b>{pct(target, 2)}</b>
          <input type="range" min={0} max={0.05} step={0.0005} value={target ?? 0} onChange={(e) => set({ budget: { ...s.budget, target_pct: Number(e.target.value) } })} />
        </label>
        {base && <p className="small">History: average {pct(base.average, 2)} · best {base.best ? pct(base.best.rate, 2) : '—'} · worst {base.worst ? pct(base.worst.rate, 2) : '—'} · default {pct(base.default_target, 2)}</p>}
        {s.budget.target_pct != null && <button className="link" onClick={() => set({ budget: { ...s.budget, target_pct: null } })}>Use the default (20% below average)</button>}
      </section>

      <section className="card">
        <h2>Cost assumptions</h2>
        <p className="muted small">Used when the real figure isn't in Launch27 (most recleans use the cleaner's actual pay for that visit).</p>
        <div className="grid-3">
          {([
            ['cleaner_hourly_default', 'Cleaner pay per hour ($)'],
            ['margin_per_hour_default', 'Gross margin per booked hour ($): the lost slot'],
            ['travel_per_visit', 'Travel per reclean visit ($)'],
            ['reclean_default_hours', 'Reclean hours when unknown'],
            ['reclean_spot_share', 'Spot reclean as a share of a full one'],
          ] as const).map(([k, label]) => (
            <label key={k}>{label}<input type="number" step="0.1" value={s.costs[k]} onChange={(e) => set({ costs: { ...s.costs, [k]: Number(e.target.value) } })} /></label>
          ))}
          <label>Credit expiry (days)<input type="number" value={s.credit_expiry_days} onChange={(e) => set({ credit_expiry_days: Number(e.target.value) })} /></label>
          <label>Pilot window (months)<input type="number" value={s.pilot_months} onChange={(e) => set({ pilot_months: Number(e.target.value) })} /></label>
        </div>
      </section>
      {canEdit && (
        <div className="actions end">
          {save.isError && <span className="error">{(save.error as Error).message}</span>}
          <button onClick={() => save.mutate(s)} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save rules'}</button>
        </div>
      )}
    </fieldset>
  );
}
