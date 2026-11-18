// Complaint playbook (Phase 1 of the Complaint Resolution Engine, Residential only).
// Playbook: what complaints we get, what we did, what kept clients and at what cost.
// Cases: every mined case with its journey, resolution, cost and outcome.
// Rules: the ladder, who approves what, the refund budget and cost assumptions.
// Supervisors and admins only (cases hold client names and what they wrote).
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useInboxMe } from '../inbox/util';
import { complaintsApi, OUTCOME_LABEL, RUNG_NAME, SOURCE_LABEL, TONE_LABEL, whatWeDid, type CaseRow, type ClientRow, type Confidence, type OutcomeStats, type Playbook, type Settings, type Status } from '../complaints/api';
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

// The history is mined and read in 3-month blocks, so a run stays around 10–15 minutes.
type PeriodKey = 'recent' | 'prior' | 'both';
interface Period { key: PeriodKey; from: string; to: string }
const PERIOD_LABEL: Record<PeriodKey, string> = { recent: 'Last 3 months', prior: '3–6 months ago', both: 'Last 6 months' };
function periodFor(key: PeriodKey, end: string): Period {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const back = (months: number, days = 0) => {
    const d = new Date(`${end}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - months);
    d.setUTCDate(d.getUTCDate() + days);
    return iso(d);
  };
  if (key === 'recent') return { key, from: back(3, 1), to: end };
  if (key === 'prior') return { key, from: back(6, 1), to: back(3) };
  return { key, from: back(6, 1), to: end };
}

export function ComplaintsPage() {
  const me = useInboxMe();
  const [tab, setTab] = useState<'playbook' | 'cases' | 'clients' | 'rules'>('playbook');
  const [periodKey, setPeriodKey] = useState<PeriodKey>('recent');
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
      {status.data && <RunBar status={status.data} isAdmin={isAdmin} period={periodFor(periodKey, status.data.window.to)} onPeriod={setPeriodKey} />}
      <div className="tabs" role="tablist">
        {(['playbook', 'cases', 'clients', 'rules'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'playbook' ? 'Playbook' : t === 'cases' ? 'Cases' : t === 'clients' ? 'Clients' : 'Rules & budget'}
          </button>
        ))}
      </div>
      {tab === 'playbook' && status.data && <PlaybookTab period={periodFor(periodKey, status.data.window.to)} />}
      {tab === 'cases' && status.data && <CasesTab period={periodFor(periodKey, status.data.window.to)} />}
      {tab === 'clients' && <ClientsTab />}
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

function RunBar({ status, isAdmin, period, onPeriod }: { status: Status; isAdmin: boolean; period: Period; onPeriod: (k: PeriodKey) => void }) {
  const qc = useQueryClient();
  const run = useMutation({ mutationFn: () => complaintsApi.run({ from: period.from, to: period.to }), onSuccess: () => qc.invalidateQueries({ queryKey: ['complaints'] }) });
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
          <div className="tabs inline" role="group" aria-label="Period">
            {(Object.keys(PERIOD_LABEL) as PeriodKey[]).map((k) => (
              <button key={k} className={`chip-btn ${period.key === k ? 'active' : ''}`} aria-pressed={period.key === k} onClick={() => onPeriod(k)}>{PERIOD_LABEL[k]}</button>
            ))}
          </div>
          <span className="muted small">{day(period.from)} – {day(period.to)}</span>
        </div>
        {isAdmin && (
          <button disabled={status.running || run.isPending || period.key === 'both'} title={period.key === 'both' ? 'Runs go one 3-month block at a time: pick "Last 3 months" or "3–6 months ago"' : undefined} onClick={() => run.mutate()}>
            {status.running || run.isPending ? 'Running…' : `Run ${PERIOD_LABEL[period.key].toLowerCase()}`}
          </button>
        )}
      </div>
      {period.key === 'both' && isAdmin && <p className="muted small">Showing both blocks together. To mine history, run each 3-month block on its own.</p>}
      {run.isError && <p className="neg small">Couldn't start the run: {(run.error as Error).message}</p>}
      {state && last && (
        <div className={`cmp-runstate ${RUN_LABEL[state]?.cls || ''}`} role="status" aria-live="polite">
          <b>{RUN_LABEL[state]?.text || state}</b>
          {status.running ? (
            <span> · {day(last.window_from)} – {day(last.window_to)} · started {clock(last.started_at)}{latest ? ` · ${latest.msg}` : ' · starting…'} · a 3-month block takes 10–15 minutes</span>
          ) : (
            <span> · {day(last.window_from)} – {day(last.window_to)} · ran {day(last.started_at)} {clock(last.started_at)}{last.finished_at ? `–${clock(last.finished_at)}` : ''}</span>
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

function PlaybookTab({ period }: { period: Period }) {
  const q = useQuery({ queryKey: ['complaints', 'playbook', period.from, period.to], queryFn: () => complaintsApi.playbook({ from: period.from, to: period.to }), retry: false, placeholderData: (prev) => prev });
  const p = q.data;
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError) return <div className="error">{(q.error as Error).message}</div>;
  if (!p) return null;
  if (!p.totals.cases) return <section className="card seg-empty"><h2>No cases for this period yet</h2><p className="muted">Pick a 3-month block above and run it to mine that period's complaints.</p></section>;
  return (
    <>
      <div className="tiles">
        <Kpi label="Complaint cases" value={String(p.totals.cases)} note={Object.entries(p.totals.by_source).map(([k, v]) => `${SOURCE_LABEL[k] || k} ${v}`).join(' · ')} />
        <Kpi label="Recurring clients kept (60 days)" value={pct(p.totals.saved)} note={`of ${p.totals.decided} weekly/biweekly/monthly clients with a known outcome`} />
        <Kpi label="Recurring clients lost" value={pct(p.totals.lost)} tone={(p.totals.lost || 0) > 0.3 ? 'warn' : undefined} />
        <Kpi label="One-time clients who booked again" value={pct(p.totals.one_time.rebooked_120)} note={`within 120 days (${pct(p.totals.one_time.rebooked_90)} within 90) · ${p.totals.one_time.decided} of ${p.totals.one_time.n} with a known outcome`} />
        <Kpi label="Total cost" value={money(p.totals.total_cost)} note={`avg ${money(p.totals.avg_cost)} per case`} />
        <Kpi label="Hard-routed" value={String(p.totals.hard_routed)} note="damage >$100, theft, safety, misconduct, legal" />
        <Kpi label="First reply (median)" value={p.response.first_response_median_hours == null ? '—' : `${p.response.first_response_median_hours} h`} note={`${p.response.with_response_time} cases with reply times`} />
      </div>

      <section className="card">
        <h2>Taxonomy: what comes up, what we did, what worked</h2>
        <p className="muted small">Saved and Lost count recurring clients only (still booking 60 days later). One-time clients are measured on whether they booked again within 120 days. "Cheapest that works" is the lowest-cost response whose save rate is within 10 points of the best one, among responses with at least 3 known outcomes. Anything marked thin rests on fewer than {p.thin_threshold} cases.</p>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Category</th><th>Share</th><th>We usually</th><th>Cases</th><th>Saved</th><th>Lost</th><th>Avg cost</th><th>Confidence</th><th>One-time: booked again</th><th>Cheapest that works</th></tr></thead>
            <tbody>
              {p.taxonomy.map((t) => (
                <tr key={t.key} className="static">
                  <td>{catLabel(t.key)}{t.hard_routed ? <span className="pill late">{t.hard_routed} hard-routed</span> : null}</td>
                  <td>{pct(t.share)}</td>
                  <td>{t.typical_name || '—'}</td>
                  <StatCells s={t} />
                  <td>{t.one_time.n ? `${pct(t.one_time.rebooked_120)} · n=${t.one_time.decided}` : '—'}</td>
                  <td>{t.cheapest_that_works ? `${t.cheapest_that_works.name} · ${pct(t.cheapest_that_works.saved)} saved · ${money(t.cheapest_that_works.avg_cost)}` : <span className="muted">not enough data</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>What we did: retention and real cost of each response</h2>
        <p className="muted small">Each case is counted at the biggest thing we gave. Refunds are grouped by size (we've actually given 20%, 30%, 40%, 50% and full). Hard-routed cases are left out (they're never on the ladder). Reclean cost includes the cleaner's pay, travel and the margin of the slot it used up.</p>
        <table>
          <thead><tr><th>Response</th><th>Level</th><th>Cases</th><th>Saved</th><th>Lost</th><th>Avg cost</th><th>Confidence</th></tr></thead>
          <tbody>
            {p.ladder.map((r) => (
              <tr key={r.rung} className="static"><td><b>{r.name}</b></td><td className="muted small">{r.tier}</td><StatCells s={r} /></tr>
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

      <section className="card">
        <h2>Reclean vs refund, like for like</h2>
        <p className="muted small">Angrier clients tend to get refunds, which makes refunds look worse than they are. This compares only similar complaints: same category, same temperature (calm or heated), same client stage (first 90 days or established), where we have both a reclean and a refund with a known outcome.</p>
        {p.like_for_like.reclean && p.like_for_like.refund ? (
          <div className="tiles">
            <Kpi label="Reclean kept" value={pct(p.like_for_like.reclean.saved)} note={`avg ${money(p.like_for_like.reclean.avg_cost)} · ${p.like_for_like.reclean.n} cases`} />
            <Kpi label="Refund kept" value={pct(p.like_for_like.refund.saved)} note={`avg ${money(p.like_for_like.refund.avg_cost)} · ${p.like_for_like.refund.n} cases`} />
            <Kpi label="Comparable pairs" value={String(p.like_for_like.matched_pairs)} note={`${p.like_for_like.groups_compared} group${p.like_for_like.groups_compared === 1 ? '' : 's'} of similar complaints`} tone={p.like_for_like.matched_pairs < p.thin_threshold ? 'warn' : undefined} />
          </div>
        ) : null}
        <p><b>{p.like_for_like.verdict}</b></p>
      </section>

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

type SortKey = 'opened_at' | 'customer_name' | 'category' | 'service' | 'client_type' | 'tone' | 'did' | 'total_cost' | 'outcome' | 'source';
const TONE_ORDER = ['mild', 'frustrated', 'angry', 'threat_leave', 'threat_review'];
const outcomeOf = (c: CaseRow) => (c.client_type === 'one_time' ? c.outcome_120 : c.outcome_60);
function sortValue(c: CaseRow, k: SortKey): string | number {
  switch (k) {
    case 'total_cost': return Number(c.total_cost) || 0;
    case 'tone': return c.tone ? TONE_ORDER.indexOf(c.tone) : -1;
    case 'category': return catLabel(c.category);
    case 'did': return whatWeDid(c.rungs);
    case 'outcome': return outcomeOf(c) || '';
    case 'source': return SOURCE_LABEL[c.source] || c.source;
    default: return String(c[k] ?? '');
  }
}

function CasesTab({ period }: { period: Period }) {
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'opened_at', dir: -1 });
  const q = useQuery({ queryKey: ['complaints', 'cases', category, period.from, period.to], queryFn: () => complaintsApi.cases({ category: category || undefined, from: period.from, to: period.to }), retry: false });
  const all = useMemo(() => q.data || [], [q.data]);
  const sources = useMemo(() => [...new Set(all.map((c) => c.source))].sort(), [all]);
  const rows = useMemo(() => {
    const list = source ? all.filter((c) => c.source === source) : [...all];
    return list.sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [all, source, sort]);
  const Th = ({ k, children }: { k: SortKey; children: string }) => (
    <th aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="link cmp-sort" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }))}>{children}{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>
    </th>
  );
  const cats = useMemo(() => Object.keys(CATEGORY_LABEL), []);
  return (
    <div className="cmp-cases">
      <section className="card no-pad">
        <div className="cmp-filter">
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {cats.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
            <option value="">All sources</option>
            {sources.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s] || s}</option>)}
          </select>
          <span className="muted small">{rows.length} cases · click a column heading to sort</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><Th k="opened_at">Opened</Th><Th k="customer_name">Client</Th><Th k="client_type">Client type</Th><Th k="service">Service</Th><Th k="category">Category</Th><Th k="tone">Tone</Th><Th k="did">What we did</Th><Th k="total_cost">Cost</Th><Th k="outcome">Outcome</Th><Th k="source">From</Th></tr></thead>
            <tbody>
              {rows.map((c: CaseRow) => (
                <tr key={c.id} className={open === c.id ? 'selected' : ''} onClick={() => setOpen(c.id)}>
                  <td>{day(c.opened_at)}</td>
                  <td>{c.customer_name || <span className="muted">unmatched</span>}</td>
                  <td>{c.client_type === 'one_time' ? 'One-time' : c.client_type === 'recurring' ? 'Recurring' : '—'}</td>
                  <td className="small">{c.service || '—'}</td>
                  <td>{catLabel(c.category)}{c.hard_route && <span className="pill late">hard route</span>}</td>
                  <td>{c.tone ? TONE_LABEL[c.tone] : '—'}</td>
                  <td>{whatWeDid(c.rungs)}</td>
                  <td>{money(Number(c.total_cost))}</td>
                  <td>{outcomeOf(c) ? OUTCOME_LABEL[outcomeOf(c) as string] : '—'}</td>
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
        <dt>Service</dt><dd>{c.service || '—'} · {c.client_type === 'one_time' ? 'One-time client' : c.client_type === 'recurring' ? 'Recurring client' : 'client type unknown'}</dd>
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
        <ul>{c.resolutions.map((r, i) => <li key={i}><b>{RUNG_NAME[r.rung || r.action] || r.action.replace(/_/g, ' ')}</b>{r.pct != null ? ` ${r.pct}%` : ''}{r.amount ? ` ${money(Number(r.amount))}` : ''}{r.decided_by ? ` · decided by ${r.decided_by}` : ''}{r.approved_by && r.approved_by !== r.decided_by ? ` · approved by ${r.approved_by}` : ''} <span className="muted small">({SOURCE_LABEL[r.source] || r.source})</span></li>)}</ul>
      ) : <p className="muted">No compensation found (apology only, or not recorded).</p>}
      <h3>Cost</h3>
      {c.costs.length ? <ul>{c.costs.map((k, i) => <li key={i}>{k.kind.replace(/_/g, ' ')}: {money(Number(k.amount))}{k.estimated ? <span className="muted small"> (estimated)</span> : ''}</li>)}</ul> : <p className="muted">$0</p>}
      <h3>Outcome</h3>
      <p>{c.outcomes.length ? c.outcomes.map((o) => `${o.day} days: ${OUTCOME_LABEL[o.outcome]}`).join(' · ') : 'Not linked to a Launch27 client, so no outcome.'}</p>
    </section>
  );
}

function ClientTable({ rows, extra, head }: { rows: ClientRow[]; head: string; extra: (r: ClientRow) => React.ReactNode }) {
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Client</th><th>Complaints (12 mo)</th><th>Last complaint</th><th>About</th><th>Cost to us</th><th>Now</th><th>{head}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.l27_customer_id} className="static">
              <td>{r.name || `Client ${r.l27_customer_id}`}</td><td>{r.complaints}</td><td>{day(r.last_complaint)}</td><td>{catLabel(r.last_category)}</td><td>{money(r.total_cost)}</td>
              <td>{OUTCOME_LABEL[r.status] || r.status}</td><td className="small">{extra(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClientsTab() {
  const q = useQuery({ queryKey: ['complaints', 'clients'], queryFn: complaintsApi.clients, retry: false });
  const c = q.data;
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError) return <div className="error">{(q.error as Error).message}</div>;
  if (!c) return null;
  return (
    <>
      <p className="muted small">Clients matched to Launch27, from every period mined so far (last 12 months). {c.clients_with_complaints} clients have at least one complaint.</p>
      <section className="card">
        <h2>At risk of leaving <span className="muted">· {c.at_risk.length}</span></h2>
        <p className="muted small">Complained in the last 60 days, still with us, and showing warning signs. Worth a personal call from the office.</p>
        {c.at_risk.length ? <ClientTable rows={c.at_risk} head="Why" extra={(r) => { const x = r as (typeof c.at_risk)[number]; return `${x.reasons.join(' · ')}${x.next_booking_on ? ` · next booking ${day(x.next_booking_on)}` : ''}`; }} /> : <p className="muted">Nobody flagged right now.</p>}
      </section>
      <section className="card">
        <h2>Repeat complainers <span className="muted">· {c.repeat.length}</span></h2>
        <p className="muted small">Two or more complaints in 12 months. The question the numbers answer: do they stay, and what do they cost us?</p>
        {c.repeat.length ? <ClientTable rows={c.repeat} head="Read" extra={(r) => { const x = r as (typeof c.repeat)[number]; return `${x.low_severity ? 'mostly minor issues' : 'serious issues'} · ${x.still_with_us ? 'still with us' : 'left'}`; }} /> : <p className="muted">None yet. This fills in as more periods are mined.</p>}
      </section>
      <section className="card">
        <h2>Escalates to a public review <span className="muted">· {c.review_mentions.length} mentioned one</span></h2>
        <p className="small warn">Google reviews aren't connected yet, so this lists clients who said they'd post a review, not reviews that were posted.</p>
        {c.review_mentions.length ? <ClientTable rows={c.review_mentions} head="Mentioned" extra={(r) => day((r as (typeof c.review_mentions)[number]).mentioned_on)} /> : <p className="muted">Nobody has mentioned a review in the periods mined.</p>}
      </section>
    </>
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
              <tr key={role} className="static"><td>{role.replace('_', ' ')}</td><td>{q.data.rungs.find((r) => r.rung === rung)?.name}{role === 'owner' ? ' (only the owner can approve above 50%)' : ''}</td></tr>
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
