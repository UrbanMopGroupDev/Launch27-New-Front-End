// A cleaner's availability as a month, read from Launch27 now, and changed there from here
// (docs/availability.md): a day off or hours on one date ("Specific date", as on Launch27's own
// calendar), time off over several days, and back to the usual hours. Each day shows the cleaner's
// visits; a change that would leave visits outside their hours says which first. The usual weekly
// hours are changed in Launch27. Ported from the Commercial portal's calendar.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCanWrite } from '../hooks';
import { saveAvailability, scheduleApi, type AffectedVisit, type AvailabilityChange, type AvailabilityDay } from './api';
import { niceDate } from './ui';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const monthOf = (d: string) => d.slice(0, 7);
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shiftMonth = (m: string, n: number) => { const x = new Date(`${m}-15T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 7); };
/** The calendar's six weeks: from the Sunday on or before the 1st. */
const gridOf = (m: string) => { const first = `${m}-01`; const start = addDays(first, -dow(first)); return { from: start, to: addDays(start, 41) }; };
const TONE: Record<AvailabilityDay['kind'], { bg: string; fg: string; label: (d: AvailabilityDay) => string }> = {
  usual: { bg: '#16a34a', fg: '#fff', label: (d) => d.hours || '' },
  changed: { bg: '#2563eb', fg: '#fff', label: (d) => d.hours || '' },
  day_off: { bg: '#e5e7eb', fg: '#374151', label: () => 'Day off' },
  off: { bg: 'transparent', fg: '#9ca3af', label: () => '' },
};

type Pending = { changes?: AvailabilityChange[]; from?: string; to?: string; note?: string; what: string };

export function AvailabilityCalendar({ cleanerId, today }: { cleanerId: number; today: string }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [month, setMonth] = useState(monthOf(today));
  const [day, setDay] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<'day' | 'timeoff' | 'history' | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ pending: Pending; affected: AffectedVisit[] } | null>(null);
  const grid = gridOf(month);
  const q = useQuery({ queryKey: ['schedule', 'availability', cleanerId, grid.from], queryFn: () => scheduleApi.availability(cleanerId, grid.from, grid.to), retry: false });
  const history = useQuery({ queryKey: ['schedule', 'availability-history', cleanerId], queryFn: () => scheduleApi.availabilityHistory(cleanerId), enabled: panel === 'history', retry: false });
  const byDate = useMemo(() => new Map((q.data?.days || []).map((d) => [d.date, d])), [q.data]);
  const editable = !!q.data?.editable && canWrite;
  const sel = day ? byDate.get(day) || null : null;

  const [hours, setHours] = useState({ start: '09:00', end: '13:00' });
  const [off, setOff] = useState({ from: '', to: '', note: '' });

  const send = async (p: Pending, sure = false) => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await saveAvailability(cleanerId, { changes: p.changes, from: p.from, to: p.to, note: p.note, confirm: sure });
      if (out.needs_confirm) {
        setConfirm({ pending: p, affected: out.affected });
        return;
      }
      setConfirm(null);
      setMsg({ ok: true, text: `Saved in Launch27: ${p.what}.${out.affected.length ? ` ${out.affected.length} visit${out.affected.length === 1 ? ' needs' : 's need'} another cleaner (see Changes in the planner).` : ''}` });
      setPanel(null);
      await qc.invalidateQueries({ queryKey: ['schedule'] });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const openDay = (d: string) => { setDay(d); setPanel('day'); setMenu(false); setMsg(null); const x = byDate.get(d); if (x?.change && !x.change.dayoff && x.change.start_time && x.change.end_time) setHours({ start: x.change.start_time, end: x.change.end_time }); };
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(grid.from, w * 7 + i)));

  return (
    <section className="card cp-card">
      <div className="cp-card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2>Availability</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="secondary" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <strong style={{ minWidth: 130, textAlign: 'center' }}>{monthName(month)}</strong>
          <button type="button" className="secondary" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
          {month !== monthOf(today) && <button type="button" className="link small" onClick={() => setMonth(monthOf(today))}>Today</button>}
          {editable && (
            <span style={{ position: 'relative' }}>
              <button type="button" onClick={() => setMenu((x) => !x)} aria-expanded={menu}>Change availability ▾</button>
              {menu && (
                <div className="card" role="menu" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, minWidth: 220, padding: 6 }}>
                  <button type="button" role="menuitem" className="link" style={{ display: 'block', padding: 6 }} onClick={() => openDay(day && day >= today ? day : today)}>Specific date</button>
                  <button type="button" role="menuitem" className="link" style={{ display: 'block', padding: 6 }} onClick={() => { setPanel('timeoff'); setMenu(false); setMsg(null); setOff({ from: day && day >= today ? day : today, to: day && day >= today ? day : today, note: '' }); }}>Time off (several days)</button>
                  <button type="button" role="menuitem" className="link" style={{ display: 'block', padding: 6 }} onClick={() => { setPanel('history'); setMenu(false); }}>History</button>
                  <div className="muted small" style={{ padding: 6, borderTop: '1px solid var(--border, #e5e7eb)', marginTop: 4 }}>Usual weekly hours: change them in Launch27 (Default Availability).</div>
                </div>
              )}
            </span>
          )}
        </div>
      </div>
      {q.isLoading && <p className="muted small">Reading Launch27…</p>}
      {q.error && <p className="error small">{(q.error as Error).message}</p>}
      {q.data && !canWrite && <p className="muted small">Read only: writes to Launch27 are turned off here.</p>}
      {msg && <p className={msg.ok ? 'small' : 'error small'} role="status">{msg.text}</p>}

      {q.data && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="avail-cal" style={{ tableLayout: 'fixed', minWidth: 640 }}>
            <thead><tr>{DOW.map((d) => <th key={d} style={{ textAlign: 'center' }}>{d}</th>)}</tr></thead>
            <tbody>{weeks.map((w) => (
              <tr key={w[0]}>{w.map((d) => {
                const x = byDate.get(d);
                const t = x ? TONE[x.kind] : TONE.off;
                const other = monthOf(d) !== month;
                const outside = (x?.visits || []).filter((v) => v.outside).length;
                const can = editable && d >= today;
                return (
                  <td key={d} style={{ verticalAlign: 'top', height: 74, padding: 4, opacity: other ? 0.45 : 1, background: d === today ? '#fef9e7' : day === d && panel === 'day' ? '#eef2ff' : undefined, cursor: can ? 'pointer' : 'default' }}
                    onClick={() => (can ? openDay(d) : x?.visits.length ? (setDay(d), setPanel('day')) : null)}>
                    <div className="small" style={{ textAlign: 'right' }}>{Number(d.slice(8))}</div>
                    {x && x.kind !== 'off' && <div className="small" style={{ background: t.bg, color: t.fg, borderRadius: 4, padding: '1px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={x.kind === 'changed' ? `Changed for this date (usually ${x.usual || 'off'})` : undefined}>{t.label(x)}</div>}
                    {x?.notes.map((n, i) => <div key={i} className="small" style={{ background: '#fde68a', color: '#713f12', borderRadius: 4, padding: '1px 4px', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={n}>{n}</div>)}
                    {x?.portal_off && <div className="small muted" title="Marked off in the portal only (before days off went to Launch27)">● off in the portal</div>}
                    {x && x.visits.length > 0 && <div className="small muted">{x.booked_h} h · {x.visits.length} visit{x.visits.length === 1 ? '' : 's'}</div>}
                    {outside > 0 && <div className="small warn">⚠ {outside} outside hours</div>}
                  </td>
                );
              })}</tr>
            ))}</tbody>
          </table>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            <span style={{ color: '#16a34a' }}>■</span> usual hours · <span style={{ color: '#2563eb' }}>■</span> changed for that date · <span style={{ color: '#9ca3af' }}>■</span> day off · read from Launch27 now{editable ? '. Click a day to change it.' : '.'}
          </p>
        </div>
      )}

      {panel === 'day' && sel && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <strong>{niceDate(sel.date)}</strong>
            <button type="button" className="link small" onClick={() => setPanel(null)}>Close</button>
          </div>
          <p className="small" style={{ margin: '4px 0' }}>
            {sel.kind === 'day_off' ? 'Day off' : sel.hours ? `Working ${sel.hours}` : 'Not a working day'}
            {sel.kind === 'changed' || sel.kind === 'day_off' ? <span className="muted"> (usually {sel.usual || 'off'})</span> : null}
          </p>
          {sel.notes.length > 0 && <p className="small" style={{ margin: '4px 0' }}>Note in Launch27: <b>{sel.notes.join(' · ')}</b></p>}
          {sel.visits.length > 0 && (
            <ul className="small" style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
              {sel.visits.map((v) => (
                <li key={v.key} className={v.outside ? 'warn' : ''}>
                  {v.time}–{v.end} · {v.customer_id ? <Link to={`/customers/${v.customer_id}`}>{v.customer}</Link> : v.customer}
                  {v.id && <> · <Link to={`/bookings/${v.id}`}>booking</Link></>}{v.outside && ' · outside their hours'}
                </li>
              ))}
            </ul>
          )}
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

      {panel === 'timeoff' && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>Time off</strong><button type="button" className="link small" onClick={() => setPanel(null)}>Close</button></div>
          <p className="muted small" style={{ margin: '4px 0 8px' }}>A day off on every date from the first to the last day, saved in Launch27 in one go.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="small">First day<input type="date" min={today} value={off.from} onChange={(e) => setOff({ ...off, from: e.target.value, to: off.to < e.target.value ? e.target.value : off.to })} /></label>
            <label className="small">Last day<input type="date" min={off.from || today} value={off.to} onChange={(e) => setOff({ ...off, to: e.target.value })} /></label>
            <label className="small" style={{ flex: 1, minWidth: 160 }}>Note (optional)<input value={off.note} onChange={(e) => setOff({ ...off, note: e.target.value })} placeholder="Vacation" /></label>
            <button type="button" disabled={busy || !off.from || !off.to} onClick={() => void send({ from: off.from, to: off.to, note: off.note || undefined, what: `time off ${niceDate(off.from)} – ${niceDate(off.to)}` })}>Save time off</button>
          </div>
        </div>
      )}

      {panel === 'history' && (
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>Changes made from the portal</strong><button type="button" className="link small" onClick={() => setPanel(null)}>Close</button></div>
          {history.isLoading ? <p className="muted small">Loading…</p> : history.data?.changes.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Date</th><th>Was</th><th>Now</th><th>By</th><th>When</th></tr></thead>
              <tbody>{history.data.changes.map((h) => (
                <tr key={h.id}>
                  <td className="small">{niceDate(h.date)}</td>
                  <td className="small">{h.before ? (h.before.kind === 'day_off' ? 'Day off' : h.before.hours || 'Off') : '—'}</td>
                  <td className="small">{h.after.dayoff ? 'Day off' : `${h.after.start_time}–${h.after.end_time}`}{h.outcome === 'failed' && <div className="warn">Not saved: {h.error}</div>}{h.note && <div className="muted">{h.note}</div>}</td>
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
          <strong>{confirm.affected.length} visit{confirm.affected.length === 1 ? '' : 's'} would be outside their hours</strong>
          <ul className="small" style={{ margin: '6px 0', paddingLeft: 18 }}>
            {confirm.affected.map((v, i) => <li key={i}>{niceDate(v.date)} {v.time}–{v.end} · {v.customer}{v.booking_id ? <> · <Link to={`/bookings/${v.booking_id}`}>booking</Link></> : null}</li>)}
          </ul>
          <p className="muted small" style={{ margin: '0 0 6px' }}>The visits stay booked with this cleaner; the planner's Changes will show them as needing another cleaner.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="danger" disabled={busy} onClick={() => void send(confirm.pending, true)}>{busy ? 'Saving…' : 'Save anyway'}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirm(null)}>Don't change</button>
          </div>
        </div>
      )}
    </section>
  );
}
