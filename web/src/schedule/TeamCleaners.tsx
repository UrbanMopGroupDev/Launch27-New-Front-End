// Contacts › Cleaners: the team in one place. Two views of the planner's copy of Launch27:
// "Team" (who they are, this week's hours) and "Availability" (each cleaner's next two weeks,
// day by day: hours, day off, changed hours). Read only; days off are changed on a cleaner's page.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { scheduleApi, type TeamCleaner, type TeamDay } from './api';
import { niceDate } from './ui';
import { displayIdentity } from '../inbox/util';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const short = (h: string | null) => (h ? h.replace(/:00/g, '').replace(/(am|pm)/g, (m) => m[0]) : '');

function DayCell({ d }: { d: TeamDay }) {
  if (d.state === 'off') return <td className="team-day off" title="Day off">Day off</td>;
  if (d.state === 'none') return <td className="team-day none" title="Not a working day">–</td>;
  const title = `${d.hours}${d.state === 'changed' && d.usual ? ` (usually ${d.usual})` : ''} · ${d.booked_h}h booked of ${d.capacity_h}h`;
  return (
    <td className={`team-day ${d.state}`} title={title}>
      <span className="team-hours">{short(d.hours)}</span>
      {d.booked_h > 0 && <span className="team-booked">{d.booked_h}h</span>}
    </td>
  );
}

export function TeamCleaners({ term }: { term: string }) {
  const [view, setView] = useState<'availability' | 'team'>('availability');
  const [all, setAll] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [onDay, setOnDay] = useState('');
  const q = useQuery({ queryKey: ['schedule', 'team-availability', from], queryFn: () => scheduleApi.teamAvailability(from || undefined, 14), staleTime: 60_000 });
  const today = q.data?.today || '';
  const start = from || today;

  const rows = useMemo(() => {
    const t = term.trim().toLowerCase();
    const digits = t.replace(/\D/g, '');
    return (q.data?.cleaners || [])
      .filter((c) => all || c.assignable)
      .filter((c) => !t || c.name.toLowerCase().includes(t) || (digits.length >= 3 && (c.phone || '').replace(/\D/g, '').includes(digits)))
      .filter((c) => !onDay || ['work', 'changed'].includes(c.days.find((x) => x.date === onDay)?.state || ''));
  }, [q.data, term, all, onDay]);
  const hidden = (q.data?.cleaners || []).filter((c) => !c.assignable).length;

  if (q.isLoading) return <div className="muted">Loading the team…</div>;
  if (q.error) return <div className="error">{(q.error as Error).message}</div>;
  if (!q.data) return null;
  const dates = q.data.dates;
  const offToday = (c: TeamCleaner) => c.days.find((x) => x.date === today)?.state === 'off';

  return (
    <>
      <div className="team-bar">
        <div className="seg" role="tablist" aria-label="View">
          <button type="button" className={view === 'availability' ? 'seg-btn active' : 'seg-btn'} onClick={() => setView('availability')}>Availability</button>
          <button type="button" className={view === 'team' ? 'seg-btn active' : 'seg-btn'} onClick={() => setView('team')}>Team</button>
        </div>
        {view === 'availability' && (
          <>
            <button type="button" className="secondary" aria-label="Previous two weeks" disabled={start <= today} onClick={() => setFrom(addDays(start, -14) < today ? null : addDays(start, -14))}>‹</button>
            <span className="small"><b>{niceDate(dates[0])} – {niceDate(dates.at(-1)!)}</b></span>
            <button type="button" className="secondary" aria-label="Next two weeks" onClick={() => setFrom(addDays(start, 14))}>›</button>
            {from && <button type="button" className="link small" onClick={() => setFrom(null)}>Today</button>}
          </>
        )}
        <label className="inline">Working on
          <select value={onDay} onChange={(e) => setOnDay(e.target.value)}>
            <option value="">any day</option>
            {dates.map((d) => <option key={d} value={d}>{niceDate(d)}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show on hold and not ready{hidden ? ` (${hidden})` : ''}</label>
      </div>

      {!rows.length ? <p className="muted">{term ? `No cleaner matches “${term}”.` : onDay ? `Nobody is working on ${niceDate(onDay)}.` : 'No cleaners.'}</p> : view === 'availability' ? (
        <div className="card no-pad">
          <div className="table-wrap flat">
            <table className="team-grid">
              <thead>
                <tr>
                  <th className="team-name">Cleaner</th>
                  {dates.map((d) => (
                    <th key={d} className={`team-dh${d === today ? ' today' : ''}${dowOf(d) === 0 || dowOf(d) === 6 ? ' wkend' : ''}`}>
                      <span>{DOW[dowOf(d)]}</span><b>{Number(d.slice(8))}</b>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="static">
                    <td className="team-name"><Link to={`/cleaners/${c.id}`}>{c.name}</Link>{!c.assignable && <span className="muted small"> · {c.status_label}</span>}{c.excluded && <span className="small warn"> · Excluded</span>}</td>
                    {c.days.map((d) => <DayCell key={d.date} d={d} />)}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="team-name muted small">Working</td>
                  {dates.map((d) => <td key={d} className="team-day sum">{rows.filter((c) => ['work', 'changed'].includes(c.days.find((x) => x.date === d)?.state || '')).length}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="muted small team-legend">
            <span className="team-key work" /> usual hours · <span className="team-key changed" /> other hours that day · <span className="team-key off" /> day off · – not a working day. Hours booked under the times. From Launch27; change a day on the cleaner's page.
          </p>
        </div>
      ) : (
        <div className="card no-pad">
          <div className="table-wrap flat">
            <table>
              <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Area</th><th>Today</th><th className="num">Booked, next 7 days</th><th className="num">Days off, next 7 days</th></tr></thead>
              <tbody>
                {rows.map((c) => {
                  const t = c.days.find((x) => x.date === today);
                  return (
                    <tr key={c.id} className="static">
                      <td><Link to={`/cleaners/${c.id}`}>{c.name}</Link></td>
                      <td>{c.phone ? displayIdentity(c.phone) : '—'}</td>
                      <td>{c.status_label}{c.excluded && <span className="chip neg" style={{ marginLeft: 6 }}>Excluded</span>}</td>
                      <td className="muted small">{c.area || '—'}</td>
                      <td className={offToday(c) ? 'warn' : t?.state === 'none' ? 'muted' : ''}>{offToday(c) ? 'Day off' : t?.hours || 'Not working'}</td>
                      <td className="num">{c.week.booked_h}h of {c.week.capacity_h}h</td>
                      <td className={`num${c.week.days_off ? ' warn' : ''}`}>{c.week.days_off || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
