// A cleaner's availability, laid out like Launch27's own Team Availability page (docs/availability.md):
// month, week and day views read from Launch27 now, with each day's hours, notes and visits. From
// "Change availability": Default Availability (usual weekly hours), Specific date (a day off or hours
// on one date), Time off over several days, Exclude from Schedule, and History. A change that would
// leave visits outside the cleaner's hours says which first.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCanWrite } from '../hooks';
import { saveAvailability, saveWeekly, scheduleApi, setExcluded, type AffectedVisit, type AvailabilityChange, type AvailabilityDay, type AvailabilityHistoryRow, type WeekDayInput, type WeeklyRow } from './api';
import { niceDate } from './ui';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYNAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const monthOf = (d: string) => d.slice(0, 7);
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const longDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shiftMonth = (d: string, n: number) => { const x = new Date(`${d.slice(0, 7)}-15T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return `${x.toISOString().slice(0, 7)}-01`; };
const weekStart = (d: string) => addDays(d, -dow(d));
/** The range a view reads: a month's six weeks from the Sunday on or before the 1st, a week, or a day. */
const rangeOf = (view: View, focus: string) => {
  if (view === 'day') return { from: focus, to: focus };
  if (view === 'week') return { from: weekStart(focus), to: addDays(weekStart(focus), 6) };
  const start = weekStart(`${monthOf(focus)}-01`);
  return { from: start, to: addDays(start, 41) };
};
const TONE: Record<AvailabilityDay['kind'], { bg: string; fg: string; label: (d: AvailabilityDay) => string }> = {
  usual: { bg: '#16a34a', fg: '#fff', label: (d) => d.hours || '' },
  changed: { bg: '#2563eb', fg: '#fff', label: (d) => d.hours || '' },
  day_off: { bg: '#e5e7eb', fg: '#374151', label: () => 'Day off' },
  off: { bg: 'transparent', fg: '#9ca3af', label: () => '' },
};
const pill = (bg: string, fg: string) => ({ background: bg, color: fg, borderRadius: 4, padding: '1px 4px', marginTop: 2, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' });
const NOTE = pill('#fde68a', '#713f12');

type View = 'month' | 'week' | 'day';
type Panel = 'day' | 'timeoff' | 'weekly' | 'history' | null;
type Pending = { changes?: AvailabilityChange[]; from?: string; to?: string; note?: string; what: string };
type WeekForm = { weekday: number; off: boolean; blocks: { start_time: string; end_time: string }[] }[];

/** The form for the usual weekly hours, from Launch27's weekly rows (Monday first, as people read a week). */
function weekFormOf(weekly: WeeklyRow[]): WeekForm {
  return [1, 2, 3, 4, 5, 6, 0].map((wd) => {
    const blocks = weekly.filter((r) => r.weekday === wd && !r.dayoff && r.start_time && r.end_time).map((r) => ({ start_time: r.start_time!, end_time: r.end_time! }));
    return { weekday: wd, off: !blocks.length, blocks: blocks.length ? blocks : [{ start_time: '09:00', end_time: '17:00' }] };
  });
}

function HistoryText({ h }: { h: AvailabilityHistoryRow }) {
  if (h.after.weekly) return <>Usual weekly hours changed</>;
  if (h.after.excluded !== undefined) return <>{h.after.excluded ? 'Excluded from schedule' : 'Back on the schedule'}</>;
  return <>{niceDate(h.date)}: {h.before ? (h.before.kind === 'day_off' ? 'Day off' : h.before.hours || 'Off') : '—'} → {h.after.dayoff ? 'Day off' : `${h.after.start_time}–${h.after.end_time}`}</>;
}

export function AvailabilityCalendar({ cleanerId, today }: { cleanerId: number; today: string }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [view, setView] = useState<View>('month');
  const [focus, setFocus] = useState(today);
  const [day, setDay] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ what: string; affected: AffectedVisit[]; go: () => Promise<void> } | null>(null);
  const range = rangeOf(view, focus);
  const q = useQuery({ queryKey: ['schedule', 'availability', cleanerId, range.from, range.to], queryFn: () => scheduleApi.availability(cleanerId, range.from, range.to), retry: false });
  const history = useQuery({ queryKey: ['schedule', 'availability-history', cleanerId], queryFn: () => scheduleApi.availabilityHistory(cleanerId), enabled: panel === 'history', retry: false });
  const byDate = useMemo(() => new Map((q.data?.days || []).map((d) => [d.date, d])), [q.data]);
  const editable = !!q.data?.editable && canWrite;
  const shown = view === 'day' ? focus : day;
  const sel = shown ? byDate.get(shown) || null : null;

  const [hours, setHours] = useState({ start: '09:00', end: '13:00' });
  const [off, setOff] = useState({ from: '', to: '', note: '' });
  const [week, setWeek] = useState<WeekForm>([]);

  const done = async (text: string) => {
    setConfirm(null);
    setMsg({ ok: true, text });
    setPanel(null);
    await qc.invalidateQueries({ queryKey: ['schedule'] });
  };
  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const needs = (n: number) => (n ? ` ${n} visit${n === 1 ? ' needs' : 's need'} another cleaner (see Changes in the planner).` : '');

  const send = (p: Pending, sure = false): Promise<void> => attempt(async () => {
    const out = await saveAvailability(cleanerId, { changes: p.changes, from: p.from, to: p.to, note: p.note, confirm: sure });
    if (out.needs_confirm) return setConfirm({ what: p.what, affected: out.affected, go: () => send(p, true) });
    await done(`Saved in Launch27: ${p.what}.${needs(out.affected.length)}`);
  });
  const sendWeekly = (sure = false): Promise<void> => attempt(async () => {
    const body: WeekDayInput[] = week.map((d) => (d.off ? { weekday: d.weekday, dayoff: true } : { weekday: d.weekday, blocks: d.blocks }));
    const out = await saveWeekly(cleanerId, body, sure);
    if (out.needs_confirm) return setConfirm({ what: 'new usual weekly hours', affected: out.affected, go: () => sendWeekly(true) });
    await done(`Saved in Launch27: usual weekly hours.${needs(out.affected.length)}`);
  });
  const toggleExcluded = () => {
    const on = !q.data?.excluded;
    if (!window.confirm(on ? `Exclude ${q.data?.cleaner.name} from the schedule? They stop being offered in booking spots until put back. Their booked visits stay as they are.` : `Put ${q.data?.cleaner.name} back on the schedule?`)) return;
    setMenu(false);
    void attempt(async () => {
      await setExcluded(cleanerId, on);
      await done(on ? 'Excluded from the schedule in Launch27.' : 'Back on the schedule in Launch27.');
    });
  };

  const openDay = (d: string) => { setDay(d); setPanel('day'); setMenu(false); setMsg(null); const x = byDate.get(d); if (x?.change && !x.change.dayoff && x.change.start_time && x.change.end_time) setHours({ start: x.change.start_time, end: x.change.end_time }); };
  const openWeekly = () => { setWeek(weekFormOf(q.data?.weekly || [])); setPanel('weekly'); setMenu(false); setMsg(null); };
  const step = (n: number) => setFocus(view === 'month' ? shiftMonth(focus, n) : addDays(focus, n * (view === 'week' ? 7 : 1)));
  const title = view === 'month' ? monthName(monthOf(focus)) : view === 'week' ? `${niceDate(range.from)} – ${niceDate(range.to)}` : longDate(focus);
  const onToday = view === 'month' ? monthOf(focus) === monthOf(today) : view === 'week' ? range.from <= today && today <= range.to : focus === today;
  const setW = (i: number, f: (d: WeekForm[number]) => WeekForm[number]) => setWeek(week.map((d, j) => (j === i ? f(d) : d)));
  const MENU_ITEM = { display: 'block', padding: 6, textAlign: 'left' as const, width: '100%' };

  const cellBody = (x: AvailabilityDay | undefined, full: boolean) => x && (
    <>
      {x.kind !== 'off' && <div className="small" style={pill(TONE[x.kind].bg, TONE[x.kind].fg)} title={x.kind === 'changed' ? `Changed for this date (usually ${x.usual || 'off'})` : undefined}>{TONE[x.kind].label(x)}</div>}
      {x.notes.map((n, i) => <div key={i} className="small" style={NOTE} title={n}>{n}</div>)}
      {x.portal_off && <div className="small muted" title="Marked off in the portal only (before days off went to Launch27)">● off in the portal</div>}
      {full
        ? x.visits.map((v) => (
          <div key={v.key} className={`small${v.outside ? ' warn' : ''}`} style={{ marginTop: 4, lineHeight: 1.25 }} title={`${v.time}–${v.end} · ${v.customer}${v.outside ? ' · outside their hours' : ''}`}>
            <b style={{ display: 'block', whiteSpace: 'nowrap' }}>{v.time}–{v.end}</b>
            <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.customer}</span>
          </div>
        ))
        : x.visits.length > 0 && <div className="small muted">{x.booked_h} h · {x.visits.length} visit{x.visits.length === 1 ? '' : 's'}</div>}
      {!full && x.visits.some((v) => v.outside) && <div className="small warn">⚠ {x.visits.filter((v) => v.outside).length} outside hours</div>}
    </>
  );
  const cellStyle = (d: string, height: number) => ({ verticalAlign: 'top' as const, height, padding: 4, background: d === today ? '#fef9e7' : shown === d && panel === 'day' ? '#eef2ff' : undefined, cursor: editable && d >= today ? 'pointer' : 'default' });
  const clickDay = (d: string) => (editable && d >= today ? openDay(d) : byDate.get(d)?.visits.length ? (setDay(d), setPanel('day')) : null);

  return (
    <section className="card cp-card">
      <div className="cp-card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>Availability</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <div className="seg" role="tablist" aria-label="View">
            {(['month', 'week', 'day'] as View[]).map((v) => <button key={v} type="button" className={view === v ? 'seg-btn active' : 'seg-btn'} onClick={() => { setView(v); if (v === 'day' && day) setFocus(day); }}>{v[0].toUpperCase() + v.slice(1)}</button>)}
          </div>
          <button type="button" className="secondary" aria-label="Previous" onClick={() => step(-1)}>‹</button>
          <strong style={{ minWidth: 130, textAlign: 'center' }}>{title}</strong>
          <button type="button" className="secondary" aria-label="Next" onClick={() => step(1)}>›</button>
          {!onToday && <button type="button" className="link small" onClick={() => setFocus(today)}>Today</button>}
          {editable && (
            <span style={{ position: 'relative' }}>
              <button type="button" onClick={() => setMenu((x) => !x)} aria-expanded={menu}>Change availability ▾</button>
              {menu && (
                <div className="card" role="menu" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, minWidth: 230, padding: 6 }}>
                  <button type="button" role="menuitem" className="link" style={MENU_ITEM} onClick={openWeekly}>Default availability</button>
                  <button type="button" role="menuitem" className="link" style={MENU_ITEM} onClick={() => openDay(shown && shown >= today ? shown : today)}>Specific date</button>
                  <button type="button" role="menuitem" className="link" style={MENU_ITEM} onClick={() => { setPanel('timeoff'); setMenu(false); setMsg(null); setOff({ from: shown && shown >= today ? shown : today, to: shown && shown >= today ? shown : today, note: '' }); }}>Request time off</button>
                  <div style={{ borderTop: '1px solid var(--border, #e5e7eb)', margin: '4px 0' }} />
                  <button type="button" role="menuitem" className="link" style={MENU_ITEM} disabled={busy || !q.data?.can.exclude} title={q.data?.can.exclude ? undefined : 'Waiting for a recording of the Launch27 save'} onClick={toggleExcluded}>{q.data?.excluded ? 'Put back on schedule' : 'Exclude from schedule'}</button>
                  <button type="button" role="menuitem" className="link" style={MENU_ITEM} onClick={() => { setPanel('history'); setMenu(false); }}>View history</button>
                </div>
              )}
            </span>
          )}
        </div>
      </div>
      {q.isLoading && <p className="muted small">Reading Launch27…</p>}
      {q.error && <p className="error small">{(q.error as Error).message}</p>}
      {q.data && !canWrite && <p className="muted small">Read only: writes to Launch27 are turned off here.</p>}
      {q.data?.excluded && <p className="small warn" style={{ margin: '6px 0' }}><b>Excluded from schedule</b>: not offered in booking spots. Change availability › Put back on schedule.</p>}
      {msg && <p className={msg.ok ? 'small' : 'error small'} role="status">{msg.text}</p>}

      {q.data && view === 'month' && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="avail-cal" style={{ tableLayout: 'fixed', minWidth: 640 }}>
            <thead><tr>{DOW.map((d) => <th key={d} style={{ textAlign: 'center' }}>{d}</th>)}</tr></thead>
            <tbody>{Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(range.from, w * 7 + i))).map((w) => (
              <tr key={w[0]}>{w.map((d) => (
                <td key={d} style={{ ...cellStyle(d, 74), opacity: monthOf(d) !== monthOf(focus) ? 0.45 : 1 }} onClick={() => clickDay(d)}>
                  <div className="small" style={{ textAlign: 'right' }}>{Number(d.slice(8))}</div>
                  {cellBody(byDate.get(d), false)}
                </td>
              ))}</tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {q.data && view === 'week' && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="avail-cal" style={{ tableLayout: 'fixed', minWidth: 760 }}>
            <thead><tr>{Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d) => <th key={d} style={{ textAlign: 'center' }}>{DOW[dow(d)]} <b>{Number(d.slice(8))}</b></th>)}</tr></thead>
            <tbody><tr>{Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d) => (
              <td key={d} style={cellStyle(d, 220)} onClick={() => clickDay(d)}>
                {cellBody(byDate.get(d), true)}
                {byDate.get(d) && !byDate.get(d)!.visits.length && byDate.get(d)!.kind !== 'off' && <div className="small muted" style={{ marginTop: 3 }}>No visits</div>}
              </td>
            ))}</tr></tbody>
          </table>
        </div>
      )}

      {q.data && (view === 'month' || view === 'week') && (
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          <span style={{ color: '#16a34a' }}>■</span> usual hours · <span style={{ color: '#2563eb' }}>■</span> changed for that date · <span style={{ color: '#9ca3af' }}>■</span> day off · <span style={{ color: '#ca8a04' }}>■</span> note · read from Launch27 now{editable ? '. Click a day to change it.' : '.'}
        </p>
      )}

      {((panel === 'day' && sel) || (view === 'day' && sel)) && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <strong>{longDate(sel.date)}</strong>
            {view !== 'day' && <button type="button" className="link small" onClick={() => setPanel(null)}>Close</button>}
          </div>
          <p className="small" style={{ margin: '4px 0' }}>
            {sel.kind === 'day_off' ? 'Day off' : sel.hours ? `Working ${sel.hours}` : 'Not a working day'}
            {sel.kind === 'changed' || sel.kind === 'day_off' ? <span className="muted"> (usually {sel.usual || 'off'})</span> : null}
            {sel.visits.length > 0 && <span className="muted"> · {sel.booked_h} h booked</span>}
          </p>
          {sel.notes.length > 0 && <p className="small" style={{ margin: '4px 0' }}>Note in Launch27: <b>{sel.notes.join(' · ')}</b></p>}
          {sel.visits.length > 0 ? (
            <ul className="small" style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
              {sel.visits.map((v) => (
                <li key={v.key} className={v.outside ? 'warn' : ''}>
                  {v.time}–{v.end} · {v.customer_id ? <Link to={`/customers/${v.customer_id}`}>{v.customer}</Link> : v.customer}
                  {v.area ? <span className="muted"> · {v.area}</span> : null}
                  {v.id && <> · <Link to={`/bookings/${v.id}`}>booking</Link></>}{v.outside && ' · outside their hours'}
                </li>
              ))}
            </ul>
          ) : <p className="muted small" style={{ margin: '4px 0 8px' }}>No visits.</p>}
          {editable && sel.date >= today ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <button type="button" className="secondary" disabled={busy || sel.kind === 'day_off'} onClick={() => void send({ changes: [{ date: sel.date, dayoff: true }], what: `day off on ${niceDate(sel.date)}` })}>Day off</button>
              <label className="small">From<input type="time" step={900} value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} /></label>
              <label className="small">To<input type="time" step={900} value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} /></label>
              <button type="button" className="secondary" disabled={busy || !hours.start || !hours.end} onClick={() => void send({ changes: [{ date: sel.date, start_time: hours.start, end_time: hours.end }], what: `${hours.start}–${hours.end} on ${niceDate(sel.date)}` })}>Set these hours</button>
              {(sel.kind === 'changed' || sel.kind === 'day_off') && <button type="button" className="secondary" disabled={busy} onClick={() => void send({ changes: [{ date: sel.date, usual: true }], what: `usual hours on ${niceDate(sel.date)}` })}>Back to usual hours</button>}
            </div>
          ) : sel.date < today ? <p className="muted small">Past days can't be changed.</p> : null}
        </div>
      )}

      {panel === 'weekly' && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>Default availability</strong><button type="button" className="link small" onClick={() => setPanel(null)}>Close</button></div>
          <p className="muted small" style={{ margin: '4px 0 8px' }}>Their usual hours every week, saved in Launch27. Dates changed one by one (Specific date, time off) keep their own hours.</p>
          {!q.data?.can.weekly && <p className="small warn">Not switched on for the live Launch27 yet: it waits for a recording of Launch27's own save. Change it in Launch27 for now.</p>}
          <div style={{ display: 'grid', gap: 6 }}>
            {week.map((d, i) => (
              <div key={d.weekday} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '4px 0', borderBottom: '1px solid var(--border, #e5e7eb)' }}>
                <b style={{ width: 92 }}>{DAYNAME[d.weekday]}</b>
                <label className="check"><input type="checkbox" checked={!d.off} onChange={(e) => setW(i, (x) => ({ ...x, off: !e.target.checked }))} /> Works</label>
                {d.off ? <span className="muted small">Day off</span> : d.blocks.map((b, k) => (
                  <span key={k} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <input type="time" step={900} aria-label={`${DAYNAME[d.weekday]} start`} value={b.start_time} onChange={(e) => setW(i, (x) => ({ ...x, blocks: x.blocks.map((y, j) => (j === k ? { ...y, start_time: e.target.value } : y)) }))} />
                    –
                    <input type="time" step={900} aria-label={`${DAYNAME[d.weekday]} end`} value={b.end_time} onChange={(e) => setW(i, (x) => ({ ...x, blocks: x.blocks.map((y, j) => (j === k ? { ...y, end_time: e.target.value } : y)) }))} />
                    {d.blocks.length > 1 && <button type="button" className="link small" aria-label="Remove these hours" onClick={() => setW(i, (x) => ({ ...x, blocks: x.blocks.filter((_, j) => j !== k) }))}>✕</button>}
                  </span>
                ))}
                {!d.off && <button type="button" className="link small" onClick={() => setW(i, (x) => ({ ...x, blocks: [...x.blocks, { start_time: '13:00', end_time: '17:00' }] }))}>+ split day</button>}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button type="button" disabled={busy || !q.data?.can.weekly} onClick={() => void sendWeekly()}>{busy ? 'Saving…' : 'Save usual hours'}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setPanel(null)}>Cancel</button>
          </div>
        </div>
      )}

      {panel === 'timeoff' && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>Request time off</strong><button type="button" className="link small" onClick={() => setPanel(null)}>Close</button></div>
          <p className="muted small" style={{ margin: '4px 0 8px' }}>A day off on every date from the first to the last day, saved in Launch27 in one go.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="small">First day<input type="date" min={today} value={off.from} onChange={(e) => setOff({ ...off, from: e.target.value, to: off.to < e.target.value ? e.target.value : off.to })} /></label>
            <label className="small">Last day<input type="date" min={off.from || today} value={off.to} onChange={(e) => setOff({ ...off, to: e.target.value })} /></label>
            <label className="small" style={{ flex: 1, minWidth: 160 }}>Note (optional, kept in the portal's history)<input value={off.note} onChange={(e) => setOff({ ...off, note: e.target.value })} placeholder="Vacation" /></label>
            <button type="button" disabled={busy || !off.from || !off.to} onClick={() => void send({ from: off.from, to: off.to, note: off.note || undefined, what: `time off ${niceDate(off.from)} – ${niceDate(off.to)}` })}>Save time off</button>
          </div>
        </div>
      )}

      {panel === 'history' && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>Changes made from the portal</strong><button type="button" className="link small" onClick={() => setPanel(null)}>Close</button></div>
          {history.isLoading ? <p className="muted small">Loading…</p> : history.data?.changes.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Change</th><th>By</th><th>When</th></tr></thead>
              <tbody>{history.data.changes.map((h) => (
                <tr key={h.id}>
                  <td className="small"><HistoryText h={h} />{h.outcome === 'failed' && <div className="warn">Not saved: {h.error}</div>}{h.note && <div className="muted">{h.note}</div>}</td>
                  <td className="small">{h.by_name || '—'}{h.source === 'mark_off' && <div className="muted">Mark off</div>}</td>
                  <td className="small">{new Date(h.at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p className="muted small">No changes from the portal yet. Launch27 keeps its own history (View History there).</p>}
        </div>
      )}

      {confirm && (
        <div className="card" role="alertdialog" style={{ marginTop: 10, borderColor: '#f59e0b' }}>
          <strong>{confirm.affected.length} visit{confirm.affected.length === 1 ? '' : 's'} would be outside their hours with {confirm.what}</strong>
          <ul className="small" style={{ margin: '6px 0', paddingLeft: 18, maxHeight: 220, overflow: 'auto' }}>
            {confirm.affected.map((v, i) => <li key={i}>{niceDate(v.date)} {v.time}–{v.end} · {v.customer}{v.booking_id ? <> · <Link to={`/bookings/${v.booking_id}`}>booking</Link></> : null}</li>)}
          </ul>
          <p className="muted small" style={{ margin: '0 0 6px' }}>The visits stay booked with this cleaner; the planner's Changes will show them as needing another cleaner.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="danger" disabled={busy} onClick={() => void confirm.go()}>{busy ? 'Saving…' : 'Save anyway'}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirm(null)}>Don't change</button>
          </div>
        </div>
      )}
    </section>
  );
}
