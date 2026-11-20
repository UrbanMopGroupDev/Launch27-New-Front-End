import { useBrand } from '../brands/useBrand';
import { brandLabel } from '../brands/ui';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { reportsApi, money, pct, type AdjustmentsInfo, type CleanerReport2, type CleanerRow2, type ChurnClient, type Factor, type Grade, type Period, type RaiseReview, type Verdict } from '../reports/api';
import { Kpi, NotBuilt, PeriodPicker, ReportStatusLine, Spark, monthYear, weekLabel } from '../reports/ui';

// Cleaner reports 2.0: Leslie's Cleaner reports plus engagement, churn, margin, re-cleans and
// reliability. Leslie's page (/reports/cleaners) is unchanged.
const BASE = '/reports/cleaners-2';
type CleanerRow = CleanerRow2;
type CleanerReport = CleanerReport2;
type SortKey = 'name' | 'visits' | 'hours_per_week' | 'hours_filled' | 'on_time' | 'happy' | 'engagement' | 'unhappy' | 'churned' | 'reliability' | 'rel_late' | 'rel_noshow' | 'rel_short' | 'rel_missing' | 'recleans' | 'google_reviews' | 'revenue' | 'earned' | 'margin';
// [key, label, one-line definition shown on hover]
const COLS: [SortKey, string, string][] = [
  ['name', 'Cleaner', ''],
  ['visits', 'Visits', 'Bookings they were on.'],
  ['hours_per_week', 'Hours / wk', 'Average hours a week on site.'],
  ['hours_filled', 'Hours filled', 'Next 4 weeks: booked hours ÷ available hours.'],
  ['on_time', 'On time', 'Checked in within the first 15 minutes of the window.'],
  ['happy', 'Happy', 'Share of rated visits rated Happy. Click for the ratings.'],
  ['unhappy', 'Unhappy', 'Unhappy ratings. Click to read them.'],
  ['churned', 'Churn', 'Recurring client, nothing booked, no clean in 60+ days. Click to see who.'],
  ['reliability', 'Reliability', '% of visits with no late cancel, no-show or missing check-in.'],
  ['recleans', 'Re-cleans', 'Launch27 Reclean visits after their clean. Click to see which.'],
  ['google_reviews', 'Google reviews', 'Review bonuses on the pay adjustments sheet. Click to see who.'],
  ['revenue', 'Revenue', 'Revenue from their visits.'],
  ['earned', 'Earned', 'What they were paid for these visits.'],
  ['margin', 'Margin', 'Revenue minus their pay.'],
  ['engagement', 'Engagement', 'Rated visits ÷ visits. Click for the ratings.'],
];
const ADMIN_COLS: SortKey[] = ['earned', 'margin'];
// Shown after Reliability when it's expanded.
const REL_PARTS: [SortKey, string, string][] = [
  ['rel_late', 'Late cancels', 'Cancelled on us under 24 hours before. From the pay adjustments sheet.'],
  ['rel_noshow', 'No-shows', "Didn't turn up. From the pay adjustments sheet."],
  ['rel_short', 'Short notice', 'Dropped a visit 24–72 hours before.'],
  ['rel_missing', 'Missing check-ins', 'Visits with no check-in or no check-out.'],
];

type DrillKind = 'churn' | 'ratings' | 'happy' | 'unhappy' | 'recleans' | 'late_cancels' | 'no_shows' | 'reviews';
type OnDrill = (c: CleanerRow, kind: DrillKind) => void;

const sortValue = (r: CleanerRow, k: SortKey): number | string | null => {
  const rs = r.reliability_score;
  if (k === 'reliability') return rs.score;
  if (k === 'rel_late') return rs.late_cancels;
  if (k === 'rel_noshow') return rs.no_shows;
  if (k === 'rel_short') return rs.short_notice;
  if (k === 'rel_missing') return rs.missing_checks;
  if (k === 'churned') return r.churned == null ? null : r.churned * 100 + (r.at_risk || 0);
  if (k === 'margin') return r.margin_dollars ?? null;
  return r[k as keyof CleanerRow] as number | string | null;
};

export const fullDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const stars = (s: number | null, n: number | null) => (s == null || !n ? null : `${s.toFixed(2)}★ (${n})`);

export function VerdictPill({ verdict, label }: { verdict: Verdict; label: string }) {
  return <span className={`rep-verdict v-${verdict}`}>{label}</span>;
}

const n = (x: number | null | undefined) => (x == null ? '—' : x || '—');

// A number that opens the rows behind it.
function Num({ value, onClick, label }: { value: React.ReactNode; onClick: () => void; label: string }) {
  return <button className="rep-num" onClick={onClick} aria-label={label}>{value}</button>;
}

function Cell({ k, c, admin, onDrill }: { k: SortKey; c: CleanerRow; admin: boolean; onDrill: OnDrill }) {
  const rs = c.reliability_score;
  const open = (kind: DrillKind) => () => onDrill(c, kind);
  switch (k) {
    case 'name':
      return (
        <td className="rep-stick">
          <div className="sch-who">
            <span className="sch-dot" style={{ background: c.color }} aria-hidden="true" />
            <div>
              <Link to={`${BASE}/${c.id}`} className="seg-name">{c.name}</Link>
              <div className="muted small">{[c.assignable ? (c.is_new ? 'New hire' : 'Active') : c.status_label, c.area, c.hours_type].filter(Boolean).join(' · ')}{c.flags.length ? ` · ${c.flags.length} flag${c.flags.length === 1 ? '' : 's'}` : ''}</div>
            </div>
          </div>
        </td>
      );
    case 'visits': return <td className="num">{c.visits}</td>;
    case 'hours_per_week': return <td className="num">{c.hours_per_week ?? '—'}</td>;
    case 'hours_filled': return <td className={`num${c.hours_filled != null && c.hours_filled < 0.5 ? ' warn' : ''}`}>{pct(c.hours_filled)}</td>;
    case 'on_time': return <td className={`num${c.on_time != null && c.on_time < 0.9 ? ' warn' : ''}`}>{pct(c.on_time)}</td>;
    case 'happy':
      return (
        <td className="num">
          {c.rated ? <Num value={pct(c.happy)} onClick={open('happy')} label={`${c.name}: happy ratings`} /> : '—'} <span className="muted small">of {c.rated}</span>
          {stars(c.stars, c.ratings_count) && <div className="muted small" title="Launch27 star rating (all time)">{stars(c.stars, c.ratings_count)}</div>}
        </td>
      );
    case 'engagement': return <td className="num">{c.rated ? <Num value={pct(c.engagement)} onClick={open('ratings')} label={`${c.name}: all ratings`} /> : pct(c.engagement)} <span className="muted small">{c.rated}/{c.visits}</span></td>;
    case 'unhappy': return <td className={`num${c.unhappy >= 2 ? ' warn' : ''}`}>{c.unhappy ? <Num value={c.unhappy} onClick={open('unhappy')} label={`${c.name}: unhappy ratings`} /> : 0}</td>;
    case 'churned':
      return (
        <td className={`num${c.churned ? ' warn' : ''}`}>
          {c.churned == null ? '—' : c.churned || c.at_risk ? <Num value={<>{c.churned}{c.at_risk ? <span className="muted small"> · {c.at_risk}</span> : null}</>} onClick={open('churn')} label={`${c.name}: churned clients`} /> : 0}
        </td>
      );
    case 'reliability':
      return (
        <td className={`num${rs.no_shows ? ' rep-bad' : rs.score != null && rs.score < 0.95 ? ' warn' : ''}`}>
          {pct(rs.score)}<div className="muted small">{rs.issues ? `${rs.issues} issue${rs.issues === 1 ? '' : 's'}` : 'no issues'}</div>
        </td>
      );
    case 'rel_late': return <td className={`num rep-sub${rs.late_cancels ? ' warn' : ''}`}>{!rs.drops_known ? '—' : rs.late_cancels ? <Num value={rs.late_cancels} onClick={open('late_cancels')} label={`${c.name}: late cancels`} /> : '—'}</td>;
    case 'rel_noshow': return <td className={`num rep-sub${rs.no_shows ? ' rep-bad' : ''}`}>{!rs.drops_known ? '—' : rs.no_shows ? <Num value={rs.no_shows} onClick={open('no_shows')} label={`${c.name}: no-shows`} /> : '—'}</td>;
    case 'rel_short': return <td className="num rep-sub">{rs.drops_known ? n(rs.short_notice) : '—'}</td>;
    case 'rel_missing': return <td className="num rep-sub">{n(rs.missing_checks)}</td>;
    case 'recleans': return <td className={`num${c.recleans ? ' warn' : ''}`}>{c.recleans ? <Num value={c.recleans} onClick={open('recleans')} label={`${c.name}: re-cleans`} /> : '—'}{c.recleans && c.reclean_rate != null ? <div className="muted small">{pct(c.reclean_rate, 1)} of visits</div> : null}</td>;
    case 'google_reviews': return <td className="num">{c.google_reviews ? <Num value={c.google_reviews} onClick={open('reviews')} label={`${c.name}: Google reviews`} /> : '—'}</td>;
    case 'revenue': return <td className="num mono">{money(c.revenue)}</td>;
    case 'earned': return admin ? <td className="num mono">{money(c.earned)}</td> : null;
    case 'margin': return admin ? <td className="num mono">{money(c.margin_dollars)}<div className="muted small">{pct(c.margin)}</div></td> : null;
  }
}

const DRILL_TITLE: Record<DrillKind, string> = { churn: 'Clients who stopped', ratings: 'Ratings', happy: 'Happy ratings', unhappy: 'Unhappy ratings', recleans: 'Re-cleans', late_cancels: 'Late cancels', no_shows: 'No-shows', reviews: 'Google reviews' };
const RATING = ['Unhappy', 'OK', 'Happy'];

// The rows behind a number on the scorecard.
function DrillModal({ c, kind, days, onClose }: { c: CleanerRow; kind: DrillKind; days: number; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const d = c.drill;
  const ratings = kind === 'happy' ? d.ratings.filter((x) => x.r === 2) : kind === 'unhappy' ? d.ratings.filter((x) => x.r === 0) : d.ratings;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal rep-drill" role="dialog" aria-modal="true" aria-label={`${DRILL_TITLE[kind]}: ${c.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="rep-raise-top">
          <h2>{DRILL_TITLE[kind]} · {c.name}</h2>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
        {kind === 'churn' && (
          <>
            <p className="muted small">Recurring clients with nothing booked ahead. Churned = no clean for {days}+ days; at risk = under {days} days. Listed under their regular cleaner.</p>
            <div className="table-scroll">
              <table className="rep-mini rep-drill-table">
                <thead><tr><th>Client</th><th>Status</th><th>Last clean</th><th>Last cleaned by</th><th className="num">Days since</th><th>With {c.name.split(' ')[0]}</th></tr></thead>
                <tbody>
                  {d.churn.map((x) => (
                    <tr key={x.customer_id}>
                      <td>{x.customer_id > 0 ? <Link to={`/customers/${x.customer_id}`}>{x.customer}</Link> : x.customer}<div className="muted small">{x.freq || ''}</div></td>
                      <td>{x.status === 'churned' ? <b className="warn">Churned</b> : 'At risk'}{x.loyal && <div className="small rep-loyal" title="5+ cleans, and at least 80% of the last 6 with this cleaner">Loyal to them</div>}</td>
                      <td>{fullDate(x.last_clean)}</td>
                      <td>{x.last_cleaner.join(' & ') || '—'}</td>
                      <td className="num">{x.days_since}</td>
                      <td className="small">{x.cleans} of {x.total_cleans} cleans{x.together_since ? ` · since ${monthYear(x.together_since)}` : ''}<div className="muted">{Math.round(x.share * 100)}% of the last 6</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.churn.some((x) => x.loyal) && <p className="small"><b>"Loyal to them"</b> clients were almost always with this cleaner and then stopped booking with us altogether. That can be a move, a price issue, or the client going direct. A call to the client is the way to find out.</p>}
          </>
        )}
        {(kind === 'ratings' || kind === 'happy' || kind === 'unhappy') && (
          <>
            <p className="muted small">{kind === 'ratings' ? `${c.rated} of ${c.visits} visits were rated (${pct(c.engagement)} engagement): ${c.happy == null ? '' : `${d.ratings.filter((x) => x.r === 2).length} happy, ${d.ratings.filter((x) => x.r === 1).length} OK, ${c.unhappy} unhappy.`}` : `${ratings.length} in this period.`}</p>
            <table className="rep-mini rep-drill-table">
              <thead><tr><th>Date</th><th>Client</th><th>Rating</th><th>Comment</th></tr></thead>
              <tbody>{ratings.map((x, i) => <tr key={i}><td>{shortDate(x.date)}</td><td>{x.customer}</td><td className={x.r === 0 ? 'warn' : x.r === 2 ? 'ok' : ''}>{RATING[x.r] || '—'}</td><td className="small">{x.comment || '—'}</td></tr>)}</tbody>
            </table>
          </>
        )}
        {kind === 'recleans' && (
          <>
            <p className="muted small">Launch27 Reclean visits. Each counts against whoever did the clean before it, not whoever went back.</p>
            <table className="rep-mini rep-drill-table">
              <thead><tr><th>Re-clean</th><th>Client</th><th>Clean that prompted it</th><th>Cleaned by</th><th>Who went back</th></tr></thead>
              <tbody>{d.recleans.map((x, i) => <tr key={i}><td>{fullDate(x.date)}</td><td>{x.customer}</td><td>{fullDate(x.original_date)}<div className="muted small">{x.gap_days} day{x.gap_days === 1 ? '' : 's'} before</div></td><td>{x.original_by.join(' & ')}</td><td>{x.by.join(' & ') || '—'}</td></tr>)}</tbody>
            </table>
          </>
        )}
        {(kind === 'late_cancels' || kind === 'no_shows') && (
          <table className="rep-mini rep-drill-table">
            <thead><tr><th>Date</th><th>Client</th><th>Source</th></tr></thead>
            <tbody>{d[kind].map((x, i) => <tr key={i}><td>{fullDate(x.date)}</td><td>{x.customer || '—'}</td><td className="small">{x.reason || '—'}</td></tr>)}</tbody>
          </table>
        )}
        {kind === 'reviews' && (
          <>
            <p className="muted small">{c.google_reviews} review{c.google_reviews === 1 ? '' : 's'} · ${c.review_bonus} in bonuses.</p>
            <table className="rep-mini rep-drill-table">
              <thead><tr><th>Date</th><th>Client</th><th className="num">Bonus</th><th>Entered by</th></tr></thead>
              <tbody>{d.reviews.map((x, i) => <tr key={i}><td>{fullDate(x.date)}</td><td>{x.reviewer}</td><td className="num">{x.amount ? `$${x.amount}` : '—'}</td><td className="small">{x.submitted_by || 'In the app'}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// Where late cancels, no-shows and Google reviews come from, and how to fix the link.
function SheetStatus({ a, admin }: { a: AdjustmentsInfo; admin: boolean }) {
  const when = a.synced_at ? new Date(a.synced_at).toLocaleString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  if (a.connected && !a.error) {
    return (
      <div className="small muted">
        Late cancels, no-shows and Google reviews come from the {a.sheet_url ? <a href={a.sheet_url} target="_blank" rel="noreferrer">pay adjustments sheet</a> : 'pay adjustments sheet'} (read {when}).
        {admin && a.unmatched && a.unmatched.length > 0 && (
          <details className="rep-unmatched">
            <summary>{a.unmatched.length} name{a.unmatched.length === 1 ? '' : 's'} on the sheet didn't match a cleaner</summary>
            <span>Fix the spelling on the sheet to match Launch27 and these rows will count: {a.unmatched.map((u) => `${u.name} (${u.rows})`).join(', ')}.</span>
          </details>
        )}
      </div>
    );
  }
  if (!admin) return <div className="small muted">Late cancels, no-shows and Google reviews aren't connected yet.</div>;
  return (
    <div className="rep-note">
      <b className="warn">The pay adjustments sheet isn't connected{a.connected ? ' (showing the last copy)' : ''}.</b> Late cancels, no-shows and Google reviews come from it.{' '}
      {a.share_with ? <>Share {a.sheet_url ? <a href={a.sheet_url} target="_blank" rel="noreferrer">the sheet</a> : 'the sheet'} with <code>{a.share_with}</code> as Viewer, then click Refresh now.</> : 'This app has no Google service account set, so it can\'t read the sheet.'}
      {a.error && <div className="small muted">Last try: {a.error}</div>}
    </div>
  );
}

export function CleanerReports2Page() {
  const [period, setPeriod] = useState<Period>('13w');
  const [scope, setScope] = useState<'active' | 'new' | 'flagged' | 'all'>('active');
  const [area, setArea] = useState<string>('');
  const [sort, setSort] = useState<SortKey>('visits');
  const [dir, setDir] = useState(-1);
  const [relOpen, setRelOpen] = useState(false);
  const [drill, setDrill] = useState<{ id: number; kind: DrillKind } | null>(null);
  const brand = useBrand();
  const q = useQuery({ queryKey: ['reports', 'cleaners2', period, brand.locationIds], queryFn: () => reportsApi.cleaners2(period, brand.locationIds), retry: false, placeholderData: (p) => p });
  const r = q.data;
  const areas = useMemo(() => [...new Set((r?.rows || []).map((x) => x.area).filter(Boolean) as string[])].sort(), [r]);
  const rows = useMemo(() => {
    const list = (r?.rows || []).filter((x) => (scope === 'all' ? true : scope === 'new' ? x.is_new : scope === 'flagged' ? x.flags.length > 0 && x.assignable : x.assignable) && (!area || x.area === area));
    return list.sort((a, b) => {
      const av = sortValue(a, sort);
      const bv = sortValue(b, sort);
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return ((av ?? -1) - (bv ?? -1)) * dir;
    });
  }, [r, scope, area, sort, dir]);
  const flagged = (r?.rows || []).filter((x) => x.assignable && x.flags.length).slice(0, 9);
  const cols = COLS.filter(([k]) => !ADMIN_COLS.includes(k) || r?.admin).flatMap((c) => (c[0] === 'reliability' && relOpen ? [c, ...REL_PARTS] : [c]));
  const scopes = [['active', 'Taking bookings'], ['new', 'New hires'], ['flagged', 'Has a flag'], ['all', 'Everyone with visits']] as const;
  return (
    <div className="seg-page">
      <header className="page-header">
        <div className="seg-head">
          <span className="small muted">Reports</span>
          <h1>Cleaner reports 2.0{brand.view !== 'both' && <span className="muted"> · {brandLabel(brand.view)}</span>}</h1>
          <p className="muted">Leslie's <Link to="/reports/cleaners">Cleaner reports</Link> plus churn, reliability, re-cleans, margin and engagement. Hover a column's ⓘ for what it means; click an underlined number to see what's behind it.{r?.admin ? ' Pay and margin are shown to admins only.' : ''}</p>
          <ReportStatusLine />
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </header>
      {q.isError && <NotBuilt message={(q.error as Error).message} />}
      {r && (
        <>
          <div className="seg-stats">
            <Kpi label="Typical cleaner" value={`${r.team.median_visits ?? '—'} visits`} note={`in this period (busiest: ${r.team.max_visits})`} />
            <Kpi label="On time, team" value={pct(r.team.on_time, 1)} note={`${r.team.check_ins} check-ins`} />
            <Kpi label="Happy ratings, team" value={pct(r.team.happy)} note="of rated visits" />
            <Kpi label="Flagged" value={`${r.team.flagged} cleaner${r.team.flagged === 1 ? '' : 's'}`} note="worth a conversation" tone={r.team.flagged ? 'warn' : undefined} />
            <Kpi label="Churned" value={r.churn_known ? `${r.team.churned} client${r.team.churned === 1 ? '' : 's'}` : '—'} note={r.churn_known ? `${r.team.at_risk} more at risk (nothing booked ahead)` : 'needs the scheduling planner'} tone={r.team.churned ? 'warn' : undefined} />
            {r.admin && <Kpi label="Paid to cleaners" value={money(r.team.earned)} note={`on ${money(r.team.revenue)} revenue`} />}
            {r.admin && r.team.margin && <Kpi label="Margin" value={money(r.team.margin.dollars)} note={`${pct(r.team.margin.share)} of revenue (homemaking left out)`} />}
            <Kpi label="Engagement rate" value={pct(r.team.engagement, 1)} note={r.team.feedback_hours != null ? `of visits get rated · typically ${r.team.feedback_hours} h after the clean` : 'of visits get rated'} />
          </div>
          <SheetStatus a={r.adjustments} admin={!!r.admin} />

          {flagged.length > 0 && (
            <section className="card rep-card">
              <h2>Needs attention</h2>
              <div className="rep-flags">
                {flagged.map((c) => (
                  <Link key={c.id} to={`${BASE}/${c.id}`} className="rep-flag">
                    <b>{c.name}</b>
                    {c.flags.map((f) => <span key={f.kind} className="small"><b className="warn">{f.label}:</b> {f.detail}</span>)}
                  </Link>
                ))}
              </div>
              {r.team.runs_long_median != null && <span className="muted small">Overtime (15%+ past booked time) is only flagged well above the team: the typical cleaner goes over on {pct(r.team.runs_long_median)} of visits. If that's high for everyone, booked times are too short.</span>}
            </section>
          )}

          <div className="sch-bar">
            <div className="seg-filter">
              {scopes.map(([k, l]) => (
                <button key={k} className={scope === k ? 'chip-btn active' : 'chip-btn'} onClick={() => setScope(k)}>{l}</button>
              ))}
            </div>
            <label className="rep-area"><span className="sr-only">Area</span>
              <select value={area} onChange={(e) => setArea(e.target.value)}><option value="">All areas</option>{areas.map((a) => <option key={a} value={a}>{a}</option>)}</select>
            </label>
          </div>

          <section className="card flush">
            <div className="seg-table-head"><h2>Scorecard</h2><span className="muted small">{rows.length} cleaners · click a column to sort, a name for their report</span></div>
            <div className="rep-scroll" tabIndex={0} aria-label="Scorecard (scrolls sideways)">
              <table className="seg-table rep-score rep-score2">
                <thead>
                  <tr>
                    {cols.map(([k, l, def]) => (
                      <th key={k} className={`${k === 'name' ? 'rep-stick' : 'num'}${k.startsWith('rel_') ? ' rep-sub' : ''}`}>
                        <button className="rep-sort" onClick={() => { setDir(sort === k ? -dir : k === 'name' ? 1 : -1); setSort(k); }}>{l}{sort === k ? (dir < 0 ? ' ↓' : ' ↑') : ''}</button>
                        {def && <span className="rep-tip" tabIndex={0} role="note" aria-label={def} data-tip={def}>ⓘ</span>}
                        {k === 'churned' && <span className="rep-th-note">· at risk</span>}
                        {k === 'reliability' && <button className="rep-expand" aria-expanded={relOpen} onClick={() => setRelOpen(!relOpen)}>{relOpen ? '− hide detail' : '+ detail'}</button>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      {cols.map(([k]) => <Cell key={k} k={k} c={c} admin={!!r.admin} onDrill={(row, kind) => setDrill({ id: row.id, kind })} />)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {drill && (() => { const row = r.rows.find((x) => x.id === drill.id); return row ? <DrillModal c={row} kind={drill.kind} days={r.churn_days} onClose={() => setDrill(null)} /> : null; })()}
            <details className="sch-pad rep-defs">
              <summary className="small">How each column is worked out</summary>
              <dl className="small">
                {cols.filter(([, , d]) => d).map(([k, l, d]) => <div key={k}><dt>{l}</dt><dd className="muted">{d}</dd></div>)}
              </dl>
            </details>
          </section>
        </>
      )}
    </div>
  );
}


const GRADE_ICON: Record<Grade, string> = { ready: '✓', watch: '△', not_yet: '✗', neutral: '·' };
const ANCHOR: Record<string, string> = { ratings: '#ratings', 'time-tracking': '#timing', reliability: '#reliability', inbox: '#complaints' };

function FactorRow({ f }: { f: Factor }) {
  const label = f.key === 'rating' ? (f.uses === 'stars' ? 'L27 stars' : 'Rating') : f.label;
  const body = (
    <>
      <span className={`rep-grade g-${f.grade}`} aria-label={f.grade.replace('_', ' ')}>{GRADE_ICON[f.grade]}</span>
      <span><b>{label}</b> {f.value}{f.key === 'rating' && f.other ? <span className="muted small"> · other system: {f.other}</span> : null}</span>
    </>
  );
  const href = f.link ? ANCHOR[f.link] : null;
  return href ? <a className="rep-factor" href={href}>{body}</a> : <div className="rep-factor">{body}</div>;
}

// Raise review: closed by default and below the evidence. It opens on the three facts the
// decision starts from (current rate, last raise, margin); the verdict and its reasons sit
// one click deeper. Admins only.
function RaisePanel({ r, name }: { r: RaiseReview; name: string }) {
  // Arriving from the monthly raise check (…#raise): open it and bring it into view.
  const fromCheck = typeof window !== 'undefined' && window.location.hash === '#raise';
  const [open, setOpen] = useState(fromCheck);
  useEffect(() => {
    if (fromCheck) document.getElementById('raise')?.scrollIntoView({ block: 'start' });
  }, [fromCheck]);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(r.summary);
      setCopied('Copied. Paste it in Slack.');
    } catch {
      setCopied('Your browser blocked the clipboard. Select the text below and copy it.');
    }
  };
  const order: Grade[] = ['ready', 'watch', 'not_yet', 'neutral'];
  const factors = [...r.factors].filter((f) => !(f.key === 'google' && f.grade === 'neutral' && f.value === '0')).sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade));
  const rate = r.rate;
  return (
    <section className="card rep-raise" aria-label="Raise review" id="raise">
      <div className="rep-raise-top">
        <h2>Raise review <span className="muted small">· admins only</span></h2>
        <button className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close review' : 'Review for a raise'}</button>
      </div>
      <div className="rep-raise-facts">
        <div><span className="muted small">Current rate</span><b>{rate ? `$${rate.current.toFixed(2)}/h` : '—'}</b><span className="small muted">{rate ? `since ${monthYear(rate.since)}` : 'not known'}</span></div>
        <div><span className="muted small">Last raise</span><b>{rate?.changed_on ? monthYear(rate.changed_on) : 'None'}</b><span className="small muted">{rate?.previous != null ? `$${rate.previous.toFixed(2)} → $${rate.current.toFixed(2)}` : 'in the last 12 months'}</span></div>
        <div><span className="muted small">Margin on their visits</span><b>{pct(r.margin)}</b><span className="small muted">revenue less their pay, last 13 weeks</span></div>
      </div>
      {open && (
        <>
          <div className="rep-raise-top">
            <span>Based on the last 13 weeks ({shortDate(r.from)} – {shortDate(r.to)}): <VerdictPill verdict={r.verdict} label={r.verdict === 'thin' ? 'Not enough data' : r.label} /></span>
          </div>
          {r.verdict === 'ladder' && r.ladder && <p className="rep-raise-note">Employee: on the ladder as <b>{r.ladder.role}</b>. {r.ladder.next ? <>Next step: <b>{r.ladder.next}</b>. </> : 'Top of the ladder. '}The factors below say whether they're ready for it (underlying: {r.underlying.replace('_', ' ')}).</p>}
          {r.verdict === 'ceiling' && <p className="rep-raise-note">Already at the $25 ceiling, so there's no $ raise to decide (underlying: {r.underlying.replace('_', ' ')}).</p>}
          {r.verdict === 'thin' && <p className="rep-raise-note">No verdict on thin data: {r.thin_reason}.</p>}
          {r.gates.length > 0 && <p className="rep-raise-note rep-bad">Held back by {r.gates.join(' and ')}: reliability comes first, whatever the ratings say.</p>}
          <div className="rep-factors">{factors.map((f) => <FactorRow key={f.key} f={f} />)}</div>
          {r.thin_ratings && <p className="muted small">Fewer than 1 in 5 visits get rated, so the rating can't carry it on its own.</p>}
          {r.to_ready.length > 0 && r.verdict !== 'ceiling' && <p><b>What would get to Ready:</b> {r.to_ready.join('; ')}.</p>}
          <div className="rep-raise-foot">
            <span>{r.re_review ? <>Look again: <b>{fullDate(r.re_review)}</b></> : ''}</span>
            <button className="secondary" onClick={copy}>Copy summary for Slack</button>
          </div>
          {copied && <div className="small" role="status">{copied}</div>}
          {copied?.startsWith('Your browser') && <textarea className="rep-summary" readOnly value={r.summary} rows={4} aria-label={`Raise summary for ${name}`} />}
        </>
      )}
    </section>
  );
}

function ReliabilityCard({ r }: { r: CleanerReport }) {
  const rel = r.reliability;
  const [all, setAll] = useState(false);
  const shown = rel.incidents.filter((i) => all || i.kind !== 'late');
  const n = (x: number | null) => (x == null ? '—' : String(x));
  return (
    <section className="card rep-card" id="reliability">
      <h2>Reliability <span className="muted small">· every visit, not a sample</span></h2>
      <div className="rep-rel-counts">
        <div className={rel.no_shows ? 'rep-bad' : ''}><span className="muted small">No-shows</span><b>{n(rel.no_shows)}</b></div>
        <div><span className="muted small">Last-minute (&lt; 24 h)</span><b>{n(rel.last_minute)}</b></div>
        <div><span className="muted small">Short notice (24–72 h)</span><b>{n(rel.short_notice)}</b></div>
        <div><span className="muted small">Missing check-in/out</span><b>{rel.missing_checks}</b></div>
        <div><span className="muted small">Late arrivals</span><b>{rel.late}</b></div>
        <div><span className="muted small">Sick days</span><b>{n(rel.sick_days)}</b></div>
      </div>
      {rel.pattern && <p className="rep-raise-note rep-bad">Pattern: {rel.pattern}. Penalised even with notice.</p>}
      {rel.uncoded ? <p className="small warn">{rel.uncoded} time{rel.uncoded === 1 ? '' : 's'} taken off a visit without a reason yet. Pick one on the Changes card in Scheduling; until then it doesn't count either way.</p> : null}
      <div className="rep-strip" role="img" aria-label="Drops per week">
        {rel.weeks.map((w) => (
          <span key={w.week} className={`rep-wk${w.drops == null ? ' none' : w.drops ? ' bad' : ''}`} title={`Week of ${shortDate(w.week)}: ${w.drops == null ? 'drops not recorded (before the change log)' : `${w.drops} drop${w.drops === 1 ? '' : 's'}`}, ${w.missing} missing check-in/out`}>{w.drops == null ? '—' : w.drops || ''}</span>
        ))}
      </div>
      <span className="muted small">Weeks before {fullDate(r.change_log_start)} show "—": Launch27 hides cancelled bookings, so drops are only known from when this app started keeping its own change log. Only cleaner-initiated reasons count; a one-off sick day with notice isn't penalised.</span>
      <table className="rep-mini">
        <thead><tr><th>Date</th><th>Client</th><th>What</th><th>Reason</th></tr></thead>
        <tbody>
          {shown.slice(0, 60).map((i, k) => (
            <tr key={k} className={i.counted ? '' : 'muted'}>
              <td>{shortDate(i.date)}</td>
              <td>{i.customer || '—'}</td>
              <td>{i.label}{i.lead_hours != null && ['last_minute', 'short_notice', 'notice', 'uncoded', 'not_cleaner'].includes(i.kind) ? <span className="muted small"> · {i.lead_hours} h notice</span> : null}</td>
              <td>{i.reason || '—'}{i.note ? <span className="muted small"> · {i.note}</span> : null}</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={4} className="muted">Nothing in this period.</td></tr>}
        </tbody>
      </table>
      {rel.late > 0 && <button className="link small" onClick={() => setAll(!all)}>{all ? 'Hide late arrivals' : `Show ${rel.late} late arrival${rel.late === 1 ? '' : 's'} too`}</button>}
    </section>
  );
}

// How many reviews, and how many $10 review bonuses were paid.
function BonusLine({ reviews }: { reviews: CleanerReport['google_reviews'] }) {
  const paid = reviews.filter((g) => g.bonus_paid).length;
  const owed = reviews.length - paid;
  return (
    <p className="small">
      {reviews.length} review{reviews.length === 1 ? '' : 's'} · <b>{paid} × $10 bonus paid (${paid * 10})</b>
      {owed ? <span className="warn"> · {owed} not paid yet</span> : null}
    </p>
  );
}

function ReviewsCard({ r }: { r: CleanerReport }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ review_date: new Date().toISOString().slice(0, 10), reviewer: '', link: '', bonus_paid: false });
  const done = () => qc.invalidateQueries({ queryKey: ['reports'] });
  const add = useMutation({ mutationFn: () => reportsApi.addReview(r.cleaner.id, { ...form, link: form.link || null }), onSuccess: () => { setOpen(false); setForm({ ...form, reviewer: '', link: '' }); done(); } });
  const bonus = useMutation({ mutationFn: ({ id, paid }: { id: number; paid: boolean }) => reportsApi.updateReview(id, { bonus_paid: paid }), onSuccess: done });
  const del = useMutation({ mutationFn: (id: number) => reportsApi.deleteReview(id), onSuccess: done });
  return (
    <section className="card rep-card" id="reviews">
      <h2>Google reviews naming them</h2>
      {r.google_reviews.length > 0 && <BonusLine reviews={r.google_reviews} />}
      {r.google_reviews.map((g) => (
        <div key={g.id} className="rep-drive">
          <span>{shortDate(g.date)} · {g.link ? <a href={g.link} target="_blank" rel="noreferrer">{g.reviewer}</a> : g.reviewer}</span>
          <span className="small">
            {r.admin ? <label><input type="checkbox" checked={g.bonus_paid} onChange={(e) => bonus.mutate({ id: g.id, paid: e.target.checked })} /> $10 bonus paid</label> : g.bonus_paid ? 'Bonus paid' : null}
            {r.admin && <button className="link small danger-link" onClick={() => del.mutate(g.id)}>Remove</button>}
          </span>
        </div>
      ))}
      {r.sheet_reviews.length > 0 && (
        <>
          <p className="small"><b>{r.sheet_reviews.length}</b> on the pay adjustments sheet this period · ${r.sheet_reviews.reduce((a, g) => a + Math.max(0, g.amount), 0)} in bonuses</p>
          {r.sheet_reviews.map((g, i) => <div key={i} className="rep-drive"><span>{shortDate(g.date)} · {g.reviewer}</span><span className="small">{g.amount ? `$${g.amount} bonus` : ''}</span></div>)}
        </>
      )}
      {r.google_reviews.length === 0 && r.sheet_reviews.length === 0 && <p className="muted small">None recorded yet.</p>}
      {open ? (
        <form className="rep-review-form" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <label>Date<input type="date" required value={form.review_date} onChange={(e) => setForm({ ...form, review_date: e.target.value })} /></label>
          <label>Reviewer<input required value={form.reviewer} onChange={(e) => setForm({ ...form, reviewer: e.target.value })} /></label>
          <label>Link<input type="url" placeholder="https://" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} /></label>
          <label className="rep-check"><input type="checkbox" checked={form.bonus_paid} onChange={(e) => setForm({ ...form, bonus_paid: e.target.checked })} /> $10 bonus paid</label>
          <div className="rep-head-actions"><button type="submit" disabled={add.isPending}>Add review</button><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button></div>
          {add.isError && <span className="error small">{(add.error as Error).message}</span>}
        </form>
      ) : (
        <button className="secondary" onClick={() => setOpen(true)}>Add Google review</button>
      )}
    </section>
  );
}

function RecleansCard({ r }: { r: CleanerReport }) {
  if (!r.recleans.length) return null;
  return (
    <section className="card rep-card" id="recleans">
      <h2>Re-cleans <span className="muted small">· from Launch27</span></h2>
      <table className="rep-mini">
        <thead><tr><th>Re-clean</th><th>Client</th><th>Clean that prompted it</th><th>Cleaned by</th><th>Who went back</th></tr></thead>
        <tbody>
          {r.recleans.map((e) => (
            <tr key={`${e.visit_id}-${e.date}`}>
              <td>{shortDate(e.date)}</td>
              <td>{e.customer}</td>
              <td>{shortDate(e.original_date)} <span className="muted small">· {e.gap_days} day{e.gap_days === 1 ? '' : 's'} before</span></td>
              <td className="small">{e.original_by.join(' & ')}</td>
              <td className="small">{e.by.join(' & ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <span className="muted small">Launch27 Reclean visits. Each counts against whoever did the client's clean before it, not whoever went back.</span>
    </section>
  );
}

function ChurnCard({ r }: { r: CleanerReport }) {
  const ch = r.churn;
  const churned = ch.clients.filter((x) => x.status === 'churned');
  const risk = ch.clients.filter((x) => x.status === 'at_risk');
  const row = (x: ChurnClient) => (
    <tr key={`${x.customer_id}`}>
      <td>{x.customer_id > 0 ? <Link to={`/customers/${x.customer_id}`}>{x.customer}</Link> : x.customer}</td>
      <td className="small">{x.freq || '—'}{x.loyal && <div className="rep-loyal" title="5+ cleans, and at least 80% of the last 6 with this cleaner">Loyal to them</div>}</td>
      <td className="small">{fullDate(x.last_clean)} · by {x.last_cleaner.join(' & ') || '—'}<div className="muted">{x.cleans} of {x.total_cleans} cleans with them</div></td>
      <td className="num small">{x.days_since} days</td>
    </tr>
  );
  return (
    <section className="card rep-card" id="churn">
      <h2>Churn <span className="muted small">· recurring clients who stopped</span></h2>
      {!ch.known ? <p className="muted small">Churn needs the scheduling planner's upcoming bookings, which aren't loaded right now.</p> : (
        <>
          <table className="rep-mini">
            <thead><tr><th>Client</th><th>Rhythm</th><th>Last clean</th><th className="num">Since</th></tr></thead>
            <tbody>
              {churned.length > 0 && <tr><td colSpan={4} className="small"><b className="warn">Churned ({churned.length})</b></td></tr>}
              {churned.map(row)}
              {risk.length > 0 && <tr><td colSpan={4} className="small"><b>At risk ({risk.length})</b> · nothing booked ahead</td></tr>}
              {risk.map(row)}
              {ch.clients.length === 0 && <tr><td colSpan={4} className="muted">No churned or at-risk clients in this period.</td></tr>}
            </tbody>
          </table>
          <span className="muted small">Churned = a recurring client with nothing booked ahead (their schedule is cancelled) and no clean for {ch.days}+ days. At risk = nothing booked ahead, under {ch.days} days so far. Counted against their regular cleaner at the last clean; homemaking and hospital-program clients are left out. {r.stats.moved > 0 ? `${r.stats.moved} other client${r.stats.moved === 1 ? '' : 's'} moved to another cleaner this period (not churn).` : ''}</span>
        </>
      )}
    </section>
  );
}

export function CleanerReport2Page() {
  const { id } = useParams();
  const [period, setPeriod] = useState<Period>('13w');
  const q = useQuery({ queryKey: ['reports', 'cleaner2', id, period], queryFn: () => reportsApi.cleaner2(Number(id), period), retry: false, placeholderData: (p) => p });
  const r = q.data;
  if (q.isError) return <NotBuilt message={(q.error as Error).message} />;
  if (!r) return <p className="muted">Loading…</p>;
  const s = r.stats;
  const c = r.cleaner;
  const initials = c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
  const lateN = r.last40.filter((x) => x.late).length;
  const starText = stars(c.stars, c.ratings_count);
  return (
    <div className="seg-page">
      <nav className="small muted"><Link to={BASE}>Cleaner reports 2.0</Link> / {c.name} · <Link to={`/reports/cleaners/${c.id}`}>Leslie's version</Link></nav>
      <section className="card rep-head">
        <div className="sch-who">
          <span className="rep-avatar" style={{ background: c.color }} aria-hidden="true">{initials}</span>
          <div>
            <h1>{c.name}</h1>
            <div className="rep-tags">
              <span className="seg-trait">{c.status_label}</span>
              {c.area && <span className="seg-trait">{c.area}</span>}
              {c.hours_type && <span className="seg-trait">{c.hours_type}</span>}
              {c.tags.slice(0, 6).map((t) => <span key={t} className={c.restrictive.some((x) => x.tag === t) ? 'seg-trait rep-restrict' : 'seg-trait'} title={c.restrictive.find((x) => x.tag === t)?.kind}>{t}</span>)}
              {c.start_date && <span className="seg-trait">{c.start_known ? `Started ${monthYear(c.start_date)}` : `Working since at least ${monthYear(c.start_date)}`}</span>}
            </div>
          </div>
        </div>
        <div className="rep-head-actions">
          <PeriodPicker value={period} onChange={setPeriod} />
          <Link className="button secondary-link" to={`/cleaners/${c.id}`}>Profile</Link>
          <Link className="button secondary-link" to={`/schedule/cleaner/${c.id}`}>Open plan</Link>
        </div>
      </section>
      {r.flags.length > 0 && (
        <div className="rep-note"><b className="warn">Worth a conversation:</b> {r.flags.map((f) => f.detail).join(' · ')}.</div>
      )}
      <div className="seg-stats">
        <div className="card seg-stat"><span className="muted small">Visits</span><span className="seg-stat-value">{s.visits}</span><Spark values={(() => { const m = Math.max(...r.series.map((w) => w.visits), 1); return r.series.map((w) => w.visits / m); })()} /><span className="small">{s.hours_per_week ?? '—'} hours a week</span></div>
        <div className="card seg-stat"><span className="muted small">Hours filled</span><span className="seg-stat-value">{pct(s.hours_filled)}</span><span className="small">{s.booked_next4 != null ? `${s.booked_next4}h of ${s.capacity_next4}h a week, next 4 weeks` : 'not in the planner'}</span></div>
        <div className="card seg-stat"><span className="muted small">On time</span><span className={s.on_time != null && s.on_time < 0.9 ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{pct(s.on_time)}</span><Spark values={r.series.map((w) => w.on_time)} warn={s.on_time != null && s.on_time < 0.9} /><span className="small">within 15 min of the window{s.late_avg ? ` · late ones by ${s.late_avg} min` : ''}</span></div>
        <div className="card seg-stat"><span className="muted small">Happy ratings</span><span className="seg-stat-value">{pct(s.happy)}</span><Spark values={r.series.map((w) => w.happy)} /><span className="small">{s.rated} rated · {s.unhappy} unhappy{starText ? <><br />Launch27 stars: {starText}</> : null}</span></div>
        <div className="card seg-stat"><span className="muted small">Finished early</span><span className={s.finished_early != null && s.finished_early > 0.2 ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{s.residential ? pct(s.finished_early) : '—'}</span><span className="small">{s.residential ? `${s.early_n} of ${s.residential} residential cleans, 30+ min under` : 'no residential solo cleans'}</span></div>
        <div className="card seg-stat" title="Rated visits ÷ visits"><span className="muted small">Engagement</span><span className="seg-stat-value">{pct(s.engagement)}</span><span className="small">{s.rated} of {s.visits} visits rated</span></div>
        <div className="card seg-stat" title="Recurring clients with nothing booked ahead: churned at 60+ days without a clean, at risk before that"><span className="muted small">Churn</span><span className={s.churned ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{s.churned == null ? '—' : s.churned}</span><span className="small">{s.churned == null ? 'needs the scheduling planner' : `churned · ${s.at_risk} at risk · ${s.moved} moved to another cleaner`}</span></div>
        <div className="card seg-stat" title="Share of their visits with no reliability issue"><span className="muted small">Reliability</span><span className={s.reliability_score.score != null && s.reliability_score.score < 0.95 ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{pct(s.reliability_score.score)}</span><span className="small">{r.reliability.no_shows ?? '—'} no-shows · {r.reliability.last_minute ?? '—'} late cancels · <a href="#reliability">detail</a></span></div>
        <div className="card seg-stat" title="Launch27: a Reclean visit, or a $0 visit, within 14 days after their clean"><span className="muted small">Re-cleans</span><span className={s.recleans ? 'seg-stat-value rep-warn' : 'seg-stat-value'}>{s.recleans}</span><span className="small">{s.recleans ? <>{pct(s.reclean_rate, 1)} of visits · <a href="#recleans">which ones</a></> : 'none in this period'}</span></div>
        {r.admin && <div className="card seg-stat" title="Revenue − their pay. Homemaking left out."><span className="muted small">Margin <span className="small">· admins</span></span><span className="seg-stat-value">{money(s.margin_dollars)}</span><span className="small">{pct(s.margin)} of {money(s.revenue)} revenue</span></div>}
        <div className="card seg-stat"><span className="muted small">Drive per visit</span><span className="seg-stat-value">{s.km_per_visit == null ? '—' : `${s.km_per_visit} km`}</span><span className="small">taps en route on {pct(s.enroute)} of visits</span></div>
      </div>
      <p className="muted small">Two rating systems: Happy % is this app's count of 😊/😐/☹ ratings in the period; Launch27 stars are all-time, as on Teams. They can disagree. The raise verdict uses whichever is better and says which.</p>

      <div className="seg-two">
        <ReliabilityCard r={r} />
        <div className="rep-side">
          <section className="card rep-card" id="complaints">
            <h2>Complaints and re-cleans</h2>
            {r.complaints.map((x) => (
              <div key={x.id} className="rep-drive">
                <Link to={`/inbox/${x.id}`}>{shortDate(x.date)} · {x.subject || `Conversation #${x.id}`}</Link>
                <span className="small">{x.outcome || 'pending'}{x.status ? ` · ${x.status}` : ''}</span>
              </div>
            ))}
            {r.complaints.length === 0 && <p className="muted small">None in this period.</p>}
            <span className="muted small">From Inbox conversations marked as a complaint with this cleaner set. Set the Cleaner on a conversation to have it count here.</span>
          </section>
          <ReviewsCard r={r} />
        </div>
      </div>

      <RecleansCard r={r} />
      <ChurnCard r={r} />

      {r.raise && <RaisePanel r={r.raise} name={c.name} />}

      <div className="seg-two">
        <section className="card flush">
          <div className="seg-table-head"><h2>Regular clients</h2><span className="muted small">{c.name.split(' ')[0]} is their usual cleaner</span></div>
          <div className="table-scroll">
            <table className="seg-table">
              <thead><tr><th>Client</th><th>Rhythm</th><th>Together since</th><th>Last rating</th></tr></thead>
              <tbody>
                {r.clients.map((x) => (
                  <tr key={x.customer_id}>
                    <td>{x.customer_id > 0 ? <Link to={`/customers/${x.customer_id}`} className="seg-name">{x.customer}</Link> : <b>{x.customer}</b>}</td>
                    <td className="small">{x.rhythm}</td>
                    <td className="small">{x.since ? monthYear(x.since) : '—'} · {x.cleans} cleans</td>
                    <td className="small">{x.last_rating ? <span className={x.last_rating.r === 0 ? 'warn' : x.last_rating.r === 2 ? 'ok' : ''}>{x.last_rating.r === 2 ? 'Happy' : x.last_rating.r === 0 ? 'Unhappy' : 'OK'}{x.last_rating.comment ? ` · "${x.last_rating.comment}"` : ''}</span> : <span className="muted">Not rated</span>}</td>
                  </tr>
                ))}
                {r.clients.length === 0 && <tr><td colSpan={4} className="muted seg-none-row">No regular clients right now.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="small sch-pad muted">Clients who stopped are under <a href="#churn">Churn</a>.</p>
        </section>
        <div className="rep-side">
          <section className="card rep-card" id="ratings">
            <h2>Recent ratings</h2>
            {r.ratings.map((x, i) => (
              <div key={i} className="rep-rating"><span className={x.r === 0 ? 'warn' : x.r === 2 ? 'ok' : ''}><b>{x.r === 2 ? 'Happy' : x.r === 0 ? 'Unhappy' : 'OK'}</b> · {weekLabel(x.date)} · {x.customer}</span>{x.comment && <span className="small">"{x.comment}"</span>}</div>
            ))}
            {r.ratings.length === 0 && <p className="muted small">No ratings yet.</p>}
          </section>
          {r.admin && (
            <section className="card rep-card">
              <h2>Pay <span className="muted small">· admins only</span></h2>
              <div className="rep-pair">
                <div><span className="muted small">Earned this period</span><b>{money(s.earned)}</b></div>
                <div><span className="muted small">Per hour on site</span><b>{s.per_hour != null ? `$${s.per_hour}` : '—'}</b></div>
              </div>
              <span className="muted small">From Launch27's team payments on each booking.{s.margin != null ? ` Margin on their visits (homemaking left out): ${pct(s.margin)}.` : ''}</span>
            </section>
          )}
        </div>
      </div>

      <section className="card rep-card" id="timing">
        <h2>Punctuality and timing, last {r.last40.length} visits</h2>
        <div className="rep-strip" role="img" aria-label={`Last ${r.last40.length} visits: ${lateN} late, ${r.last40.filter((x) => x.long).length} went 15% or more over booked time, ${r.last40.filter((x) => x.early).length} finished 30+ min early`}>
          {r.last40.map((x, i) => <span key={i} className={`rep-cell${x.late ? ' late' : ''}${x.long ? ' long' : ''}${x.early ? ' early' : ''}`} title={`${weekLabel(x.date)} · ${x.customer}${x.late ? ` · ${x.late} min late` : ' · on time'}${x.long ? ' · overtime' : ''}${x.early ? ' · finished early' : ''}`} />)}
        </div>
        <div className="sch-legend rep-legend">
          <span><i className="rep-cell" />On time</span>
          <span><i className="rep-cell late" />Late</span>
          <span><i className="rep-cell long" />Overtime (15%+ over booked time)</span>
          <span><i className="rep-cell early" />Finished 30+ min early</span>
        </div>
        {r.team.runs_long_median != null && <span className="muted small">Overtime: the team goes 15%+ over booked time on {pct(r.team.runs_long_median)} of visits. Finishing early on residential cleans is the quality risk.</span>}
        {r.finished_early.length > 0 && (
          <details>
            <summary className="small">Finished early in this period ({r.finished_early.length})</summary>
            <table className="rep-mini">
              <thead><tr><th>Date</th><th>Client</th><th className="num">Under booked</th></tr></thead>
              <tbody>{r.finished_early.map((x) => <tr key={x.visit_id}><td>{shortDate(x.date)}</td><td>{x.customer}</td><td className="num">{x.short_min} min</td></tr>)}</tbody>
            </table>
          </details>
        )}
        <Link className="small" to="/time-tracking">Open Time tracking</Link>
      </section>
    </div>
  );
}
