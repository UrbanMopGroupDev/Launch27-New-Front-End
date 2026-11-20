// KPI scorecard (Reports → KPI scorecard): the monthly scorecard, read-only. Every number
// comes from the server's calc module (server/src/kpi/calc.js); this page only renders it.
// A tile with a missing or stale source shows "No data" or "Stale", never a number.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { kpiApi, type Drill, type DrillRow, type Kpi, type ManualReviews, type Mode, type Query, type Reference, type Scorecard, type Tile, type Tone, type TrendPoint } from '../kpi/api';

const fmtValue = (t: { unit: Tile['unit'] }, v: number) => (t.unit === 'pct' ? `${v.toFixed(1)}%` : t.unit === 'per100' ? v.toFixed(2) : v.toLocaleString('en-CA'));
const signed = (v: number, digits: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
const fmtDelta = (d: NonNullable<Tile['delta']>) => (d.unit === 'pp' ? `${signed(d.value, 1)} pp` : d.unit === 'per100' ? signed(d.value, 2) : signed(d.value, 0));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');
const shortMonth = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' });
const longMonth = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const UNIT_NOTE: Record<string, string> = { per100: 'per 100 visits', count: 'new this period' };
const TONE_ICON: Record<Tone, string> = { good: '●', warning: '⚠', critical: '🔴', neutral: '' };

export function KpiScorecardPage() {
  const [brand, setBrand] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('month');
  const [outage, setOutage] = useState<string | null>(null);
  const [drill, setDrill] = useState<string | null>(null);
  // Summary for a quick read; Detailed opens every tile's breakdown. Remembered per browser.
  const [view, setView] = useState<'summary' | 'detailed'>(() => { try { return localStorage.getItem('kpi:view') === 'detailed' ? 'detailed' : 'summary'; } catch { return 'summary'; } });
  const pickView = (v: 'summary' | 'detailed') => { setView(v); try { localStorage.setItem('kpi:view', v); } catch { /* storage unavailable */ } };
  // Custom dates: the request goes out once both dates are set and in order.
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const rangeReady = mode !== 'range' || (!!range.from && !!range.to && range.from <= range.to);
  const query: Query = { brand, month, mode, outage, from: range.from, to: range.to };
  const q = useQuery({ queryKey: ['kpi', 'scorecard', brand, month, mode, outage, mode === 'range' ? range.from : '', mode === 'range' ? range.to : ''], queryFn: () => kpiApi.scorecard(query), retry: false, placeholderData: (p) => p, enabled: rangeReady });
  const s = q.data;
  return (
    <div className="seg-page sc-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Reports</span>
          <h1>KPI scorecard{s && <span className="muted"> · {s.brand.name}</span>}</h1>
          <p className="muted">{s ? `${s.brand.detail} · ${s.period}` : 'Monthly scorecard'}{s?.synthetic && <span className="sc-synthetic"> Synthetic data: not real numbers</span>}</p>
        </div>
        {s && (
          <div className="sc-controls">
            {s.brands.length > 1 && (
              <div className="seg-period" role="group" aria-label="Brand">
                {s.brands.map((b) => (
                  <button key={b.key} className={s.brand.key === b.key ? 'active' : ''} aria-pressed={s.brand.key === b.key} onClick={() => setBrand(b.key)}>{b.name}</button>
                ))}
              </div>
            )}
            <div className="seg-period" role="group" aria-label="Level of detail">
              <button className={view === 'summary' ? 'active' : ''} aria-pressed={view === 'summary'} onClick={() => pickView('summary')}>Summary</button>
              <button className={view === 'detailed' ? 'active' : ''} aria-pressed={view === 'detailed'} onClick={() => pickView('detailed')}>Detailed</button>
            </div>
            <div className="seg-period" role="group" aria-label="Period">
              <button className={mode === 'month' ? 'active' : ''} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>Month</button>
              <button className={mode === 't12' ? 'active' : ''} aria-pressed={mode === 't12'} onClick={() => setMode('t12')}>Trailing 12</button>
              <button className={mode === 'range' ? 'active' : ''} aria-pressed={mode === 'range'} onClick={() => { if (!range.from) setRange({ from: `${s.today.slice(0, 7)}-01`, to: s.today }); setMode('range'); }}>Custom dates</button>
            </div>
            {mode === 'range' ? (
              <div className="sc-range">
                <label className="sc-month">
                  <span className="small muted">From</span>
                  <input type="date" value={range.from} min={s.first_day} max={range.to || s.today} onChange={(e) => setRange({ ...range, from: e.target.value })} />
                </label>
                <label className="sc-month">
                  <span className="small muted">To</span>
                  <input type="date" value={range.to} min={range.from || s.first_day} max={s.today} onChange={(e) => setRange({ ...range, to: e.target.value })} />
                </label>
              </div>
            ) : (
              <label className="sc-month">
                <span className="small muted">{mode === 't12' ? '12 months ending' : 'Month'}</span>
                <select value={s.month} onChange={(e) => setMonth(e.target.value)}>
                  {s.months.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}{m.value === s.default_month ? ' (last closed)' : ''}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </header>
      {!rangeReady && <p className="muted">Pick a start date and an end date, with the start first.</p>}
      {q.isError && (
        <section className="card seg-empty">
          <h2>The scorecard isn't available</h2>
          <p className="muted">{(q.error as Error).message}</p>
        </section>
      )}
      {s && (
        <>
          <section className="sc-tiles" aria-label="KPIs">
            {s.tiles.map((t) => <TileCard key={t.kpi} tile={t} detailed={view === 'detailed'} onDrill={setDrill} />)}
          </section>
          <section aria-label="12-month trends">
            <h2 className="sc-section">12-month trend <span className="muted small">to {longMonth(s.month)}</span></h2>
            <div className="sc-trends">
              {s.tiles.filter((t) => t.state !== 'disabled').map((t) => <TrendCard key={t.kpi} tile={t} points={s.trends[t.kpi] || null} reference={s.references[t.kpi] || null} />)}
            </div>
          </section>
          <SourcesCard s={s} outage={outage} setOutage={setOutage} />
        </>
      )}
      {s && drill && <DrillPanel query={{ ...query, brand: s.brand.key, month: mode === 'range' ? null : s.month }} kpi={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ---------- tile ----------
// Summary (the default): the number, its status, the change, Target and Last 12 months.
// "Details" (or the page's Detailed view) adds the breakdown; "View rows" goes to the bookings.
function TileCard({ tile: t, detailed, onDrill }: { tile: Tile; detailed: boolean; onDrill: (kpi: string) => void }) {
  const [info, setInfo] = useState(false);
  const [open, setOpen] = useState(false);
  const live = t.state === 'ok';
  const more = detailed || open;
  return (
    <article className={`card sc-tile sc-${t.state}${t.status ? ` sc-tone-${t.status.tone}` : ''}`}>
      <header className="sc-tile-head">
        <h2>{t.label}</h2>
        {t.state !== 'disabled' && (
          <button className="sc-info" aria-expanded={info} aria-label={`How ${t.label} is calculated`} title="How this is calculated" onClick={() => setInfo(!info)}>i</button>
        )}
      </header>
      {info && <p className="sc-formula" role="note">{t.formula}</p>}
      {live && t.value != null ? (
        <>
          <div className="sc-value-row">
            <span className="sc-value">{fmtValue(t, t.value)}</span>
            {t.unit && UNIT_NOTE[t.unit] && <span className="muted small">{UNIT_NOTE[t.unit]}</span>}
            {t.status && <span className={`sc-status sc-status-${t.status.tone}`}>{TONE_ICON[t.status.tone]} {t.status.label}</span>}
          </div>
          <div className="sc-delta">
            {t.delta ? (
              <>
                <span className={t.delta.better == null ? 'sc-flat' : t.delta.better ? 'sc-better' : 'sc-worse'}>
                  {t.delta.value > 0 ? '▲' : t.delta.value < 0 ? '▼' : '■'} {fmtDelta(t.delta)}{t.delta.better != null && <span> · {t.delta.better ? 'better' : 'worse'}</span>}
                </span>
                <span className="muted"> vs {t.delta.versus}</span>
              </>
            ) : <span className="muted">No earlier period to compare</span>}
          </div>
          <dl className="sc-refs">
            <div><dt>Target</dt><dd>{t.target || <span className="muted">Not set</span>}</dd></div>
            <div><dt>Last 12 months</dt><dd>{t.last12 || <span className="muted">—</span>}</dd></div>
          </dl>
          {t.badges.map((b) => <p key={b.text} className={`sc-badge sc-status-${b.tone}`}>{TONE_ICON[b.tone]} {b.text}</p>)}
          {more && (
            <div className="sc-more">
              <dl className="sc-details">
                {t.details.map((d) => (
                  <div key={d.label}>
                    <dt>{d.label}</dt>
                    <dd>{d.drill ? <button className="link" onClick={() => onDrill(d.drill!)}>{d.value} · view</button> : d.value}</dd>
                  </div>
                ))}
              </dl>
              {t.breakdown && t.breakdown.length > 0 && (
                <div className="sc-breakdown">
                  <span className="small muted">Not fulfilled, by reason</span>
                  {t.breakdown.map((m) => (
                    <div key={m.kind + m.label} className="sc-miss">
                      <span>{m.label} <i className="muted">· {m.kind === 'company' ? 'ours' : m.kind === 'client' ? 'client' : 'unclear'}</i></span>
                      <span className="sc-miss-bar"><span style={{ width: `${(m.n / Math.max(...t.breakdown!.map((x) => x.n))) * 100}%` }} /></span>
                      <span className="sc-num">{m.n}</span>
                    </div>
                  ))}
                </div>
              )}
              {t.weeks && (
                <div className="sc-weeks">
                  <span className="small muted">By week</span>
                  <div>
                    {t.weeks.map((w) => <span key={w.from} title={`${w.from} to ${w.to}: ${w.num} of ${w.den}`}><b>{w.value == null ? '—' : `${w.value.toFixed(0)}%`}</b><i>{w.from.slice(8)}–{w.to.slice(8)}</i></span>)}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="sc-empty">
          <span className="sc-value sc-value-none">{t.state === 'disabled' ? 'Coming later' : t.state === 'stale' ? 'Stale' : 'No data'}</span>
          {t.note && t.state !== 'disabled' && <p className="muted small">{t.note}</p>}
        </div>
      )}
      {t.state !== 'disabled' && (
        <footer className="sc-foot">
          <span className="small muted">{t.period} · {t.sources.map((x) => x.label).join(' + ')} · refreshed {when(t.refreshed_at)}</span>
          {live && (
            <span className="sc-foot-actions">
              {!detailed && <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>}
              <button className="link" onClick={() => onDrill(t.kpi)}>View rows</button>
            </span>
          )}
        </footer>
      )}
    </article>
  );
}

// ---------- 12-month trend: one small line chart per KPI (single series, shared style) ----------
const W = 340, H = 132, L = 38, R = 14, T = 12, B = 22;
function TrendCard({ tile, points, reference }: { tile: Tile; points: TrendPoint[] | null; reference: Reference | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const vals = (points || []).map((p) => p.value).filter((v): v is number => v != null);
  if (!points || vals.length < 2) {
    return (
      <div className="card sc-trend">
        <h3>{tile.label}</h3>
        <p className="muted small sc-trend-none">{tile.state === 'stale' ? 'Stale: no trend shown' : 'No data'}</p>
      </div>
    );
  }
  const band = reference?.band || null;
  const refLine = reference?.line ?? null;
  const refs = [...(band || []), ...(refLine != null ? [refLine] : [])];
  let lo = Math.min(...vals, ...refs), hi = Math.max(...vals, ...refs);
  const padY = (hi - lo || 1) * 0.15;
  lo = Math.max(0, lo - padY);
  hi += padY;
  const x = (i: number) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  // Break the line at months with no data: a gap, never a zero.
  const segs: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (p.value == null) { if (cur.length) segs.push(cur.join(' ')); cur = []; } else cur.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur.join(' '));
  const fmt = (v: number) => (tile.unit === 'pct' ? `${v.toFixed(1)}%` : tile.unit === 'per100' ? v.toFixed(2) : String(v));
  const axis = (v: number) => (tile.unit === 'pct' ? `${v.toFixed(0)}%` : tile.unit === 'per100' ? v.toFixed(1) : v.toFixed(0));
  const move = (e: React.MouseEvent | React.TouchEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const i = Math.round((((cx - box.left) / box.width) * W - L) / ((W - L - R) / (points.length - 1)));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const h = hover != null ? points[hover] : null;
  const last = points.length - 1;
  return (
    <div className="card sc-trend">
      <h3>{tile.label} <span className="muted small">{tile.unit === 'per100' ? 'per 100 visits' : tile.unit === 'count' ? 'new reviews' : ''}</span></h3>
      <div className="sc-chart">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${tile.label}, ${longMonth(points[0].month)} to ${longMonth(points[last].month)}: ${points.map((p) => (p.value == null ? 'no data' : fmt(p.value))).join(', ')}`} onMouseMove={move} onMouseLeave={() => setHover(null)} onTouchStart={move} onTouchMove={move}>
          {band && <rect x={L} y={y(band[1])} width={W - L - R} height={y(band[0]) - y(band[1])} className="sc-band" />}
          {refLine != null && <line x1={L} x2={W - R} y1={y(refLine)} y2={y(refLine)} className="sc-ref" />}
          {[lo, hi].map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="sc-grid" /><text x={L - 6} y={y(v) + 3} textAnchor="end" className="sc-axis">{axis(v)}</text></g>)}
          {[0, Math.floor(last / 2), last].map((i) => <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="sc-axis">{shortMonth(points[i].month)}{i !== Math.floor(last / 2) ? ` ’${points[i].month.slice(2, 4)}` : ''}</text>)}
          {segs.map((sg) => <polyline key={sg} points={sg} className="sc-line" />)}
          {points.map((p, i) => p.value != null && (p.flag || i === last) && <circle key={p.month} cx={x(i)} cy={y(p.value)} r={4} className={p.flag ? 'sc-dot sc-dot-flag' : 'sc-dot'} />)}
          {h && h.value != null && <g><line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} className="sc-cross" /><circle cx={x(hover!)} cy={y(h.value)} r={5} className="sc-dot" /></g>}
        </svg>
        {h && (
          <div className="sc-tip" style={{ left: `${(x(hover!) / W) * 100}%` }} data-side={hover! > last / 2 ? 'left' : 'right'}>
            <b>{longMonth(h.month)}</b>
            <span>{h.value == null ? 'No data' : fmt(h.value)}{h.value != null && h.den != null && tile.kpi !== 'ocr' ? ` · ${h.num} of ${h.den.toLocaleString('en-CA')}` : ''}</span>
            {h.flag && <span className="sc-status-warning">⚠ {h.flag}</span>}
          </div>
        )}
      </div>
      <p className="small muted sc-trend-foot">Latest: <b>{points[last].value == null ? 'no data' : fmt(points[last].value!)}</b> · range {fmt(Math.min(...vals))} to {fmt(Math.max(...vals))}{points.some((p) => p.flag) ? ' · hollow dots are flagged months' : ''}{band ? ` · shaded band: ${reference!.label}` : ''}{refLine != null ? ` · dashed line: ${reference!.label}` : ''}</p>
    </div>
  );
}

// ---------- sources, outage preview and manual review entry ----------
function SourcesCard({ s, outage, setOutage }: { s: Scorecard; outage: string | null; setOutage: (o: string | null) => void }) {
  const queryClient = useQueryClient();
  const refresh = useMutation({ mutationFn: kpiApi.refresh, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kpi'] }) });
  return (
    <details className="card sc-sources" open={!!outage}>
      <summary>Sources and data freshness</summary>
      <div className="sc-source-list">
        {s.sources.map((x) => (
          <div key={x.key}>
            <b>{x.label}</b>
            <span className="small muted">{x.refreshed_at ? `Refreshed ${when(x.refreshed_at)}` : x.note ? x.note.charAt(0).toUpperCase() + x.note.slice(1) : 'Not connected'}{x.mode === 'synthetic' ? ' · synthetic' : ''}</span>
          </div>
        ))}
      </div>
      <p className="small muted">Read-only: this page never changes anything in Launch27, QuickBooks, Kustomer or Google.</p>
      {s.refresh.available && (
        <p className="small">
          {s.refresh.running || refresh.isSuccess ? <span className="muted">Refreshing now (Launch27 takes about seven minutes the first time). Reload the page afterwards.</span> : <button className="link" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh now</button>}
          {refresh.isError && <span className="warn"> {(refresh.error as Error).message}</span>}
        </p>
      )}
      {s.outages && (
        <div className="sc-dev">
          <span className="sc-dev-tag">{s.env === 'staging' ? 'QA' : 'Dev'} only</span>
          <label>
            <span className="small">Preview a source outage</span>
            <select value={outage || ''} onChange={(e) => setOutage(e.target.value || null)}>
              <option value="">None (all sources fresh)</option>
              {Object.entries(s.outages).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          {s.manual_reviews.can_enter && <ManualReviewsForm key={`${s.brand.key}${s.month}`} s={s} />}
        </div>
      )}
    </details>
  );
}

function ManualReviewsForm({ s }: { s: Scorecard }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const e = s.manual_reviews.entry;
  const [form, setForm] = useState({ new_reviews: e ? String(e.new_reviews) : '', avg_rating: e ? String(e.avg_rating) : '', alltime_avg: e ? String(e.alltime_avg) : '', alltime_count: e ? String(e.alltime_count) : '' });
  const done = () => { queryClient.invalidateQueries({ queryKey: ['kpi'] }); setOpen(false); };
  const save = useMutation({ mutationFn: () => kpiApi.saveReviews(s.brand.key, s.month, Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v)])) as unknown as ManualReviews), onSuccess: done });
  const clear = useMutation({ mutationFn: () => kpiApi.clearReviews(s.brand.key, s.month), onSuccess: done });
  const field = (key: keyof typeof form, label: string, step: string) => (
    <label>
      <span className="small">{label}</span>
      <input type="number" inputMode="decimal" step={step} min="0" required value={form[key]} onChange={(ev) => setForm({ ...form, [key]: ev.target.value })} />
    </label>
  );
  if (!open) return <button className="link" onClick={() => setOpen(true)}>{e ? `Edit manual Google reviews for ${longMonth(s.month)}` : `Enter Google reviews by hand for ${longMonth(s.month)}`}</button>;
  return (
    <form className="sc-manual" onSubmit={(ev) => { ev.preventDefault(); save.mutate(); }}>
      <b>Google reviews for {longMonth(s.month)} (manual entry)</b>
      <div>
        {field('new_reviews', 'New reviews', '1')}
        {field('avg_rating', 'Average rating (month)', '0.01')}
        {field('alltime_count', 'All-time reviews', '1')}
        {field('alltime_avg', 'All-time average', '0.01')}
      </div>
      {(save.isError || clear.isError) && <p className="error">{((save.error || clear.error) as Error).message}</p>}
      <div className="sc-manual-actions">
        <button type="submit" disabled={save.isPending}>Save</button>
        {e && <button type="button" className="link" disabled={clear.isPending} onClick={() => clear.mutate()}>Remove manual entry</button>}
        <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

// ---------- drill-down ----------
type Filter = 'all' | 'counted' | 'excluded' | 'issues';
function DrillPanel({ query, kpi, onClose }: { query: Query; kpi: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['kpi', 'drill', kpi, query.brand, query.month, query.mode, query.outage, query.from, query.to], queryFn: () => kpiApi.drill(query, kpi), retry: false });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="modal-backdrop sc-drill-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card sc-drill" role="dialog" aria-modal="true" aria-label={q.data?.title || 'Rows'}>
        <header className="sc-drill-head">
          <h2>{q.data?.title || 'Loading…'}</h2>
          <button className="link" onClick={onClose}>Close</button>
        </header>
        {q.isError && <p className="error">{(q.error as Error).message}</p>}
        {q.data && <DrillTabs data={q.data} />}
      </div>
    </div>
  );
}

function DrillTabs({ data }: { data: Drill }) {
  const [tabKey, setTabKey] = useState(data.tabs[0].key);
  const tab = data.tabs.find((t) => t.key === tabKey) || data.tabs[0];
  const hasExcluded = tab.rows.some((r) => r.counted === false);
  const [filter, setFilter] = useState<Filter>((tab.defaultFilter as Filter) || 'all');
  const [text, setText] = useState('');
  const [limit, setLimit] = useState(200);
  useEffect(() => { setFilter((tab.defaultFilter as Filter) || 'all'); setLimit(200); }, [tab]);
  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return tab.rows.filter((r: DrillRow) => {
      if (filter === 'counted' && r.counted === false) return false;
      if (filter === 'excluded' && r.counted !== false) return false;
      if (filter === 'issues' && r.issue === false) return false;
      return !needle || tab.columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(needle));
    });
  }, [tab, filter, text]);
  const cell = (r: DrillRow, c: Drill['tabs'][number]['columns'][number]) => {
    const v = r[c.key];
    if (v == null || v === '') return '';
    if (c.kind === 'money') return Number(v).toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
    if (c.kind === 'pct') return `${Number(v).toFixed(1)}%`;
    return String(v);
  };
  const filters: [Filter, string][] = tab.defaultFilter === 'issues' ? [['issues', 'Not fulfilled or late'], ['all', 'All bookings']] : hasExcluded ? [['all', 'All'], ['counted', 'Counted'], ['excluded', 'Excluded']] : [];
  return (
    <>
      {data.tabs.length > 1 && (
        <div className="tabs" role="tablist">
          {data.tabs.map((t) => <button key={t.key} role="tab" aria-selected={t.key === tab.key} className={t.key === tab.key ? 'tab active' : 'tab'} onClick={() => setTabKey(t.key)}>{t.label} ({t.rows.length.toLocaleString('en-CA')})</button>)}
        </div>
      )}
      <div className="sc-drill-tools">
        {filters.length > 0 && (
          <div className="seg-period" role="group" aria-label="Show">
            {filters.map(([f, label]) => <button key={f} className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</button>)}
          </div>
        )}
        <input type="search" placeholder="Search these rows" aria-label="Search these rows" value={text} onChange={(e) => setText(e.target.value)} />
        <span className="small muted">{rows.length.toLocaleString('en-CA')} row{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div className="table-wrap sc-drill-table">
        <table>
          <thead><tr>{tab.columns.map((c) => <th key={c.key} className={c.kind ? 'sc-num' : ''}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.slice(0, limit).map((r, i) => (
              <tr key={i} className={r.counted === false ? 'sc-row-out' : ''}>
                {tab.columns.map((c) => <td key={c.key} className={c.kind ? 'sc-num' : ''} data-label={c.label}>{cell(r, c)}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={tab.columns.length} className="muted">No rows</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <button className="link" onClick={() => setLimit(limit + 500)}>Show more ({(rows.length - limit).toLocaleString('en-CA')} left)</button>}
    </>
  );
}

export type { Kpi };
