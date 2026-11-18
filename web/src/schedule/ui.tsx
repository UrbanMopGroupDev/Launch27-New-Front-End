// Shared pieces for the scheduling planner.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { scheduleApi, type ClientTags, type Reason, type Visit } from './api';

export function niceDate(d: string, short = false) {
  const dt = new Date(`${d}T12:00:00Z`);
  return dt.toLocaleDateString('en-CA', short ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function CleanerDot({ color }: { color: string }) {
  return <span className="sch-dot" style={{ background: color }} aria-hidden="true" />;
}

export function FreqPill({ visit }: { visit: Pick<Visit, 'kind' | 'freq' | 'prepaid'> }) {
  return (
    <span className={`sch-freq f-${visit.kind}`}>
      {visit.prepaid && <span className="sch-p" title="Prepaid">P</span>}
      {visit.freq}
    </span>
  );
}

export function Reasons({ reasons }: { reasons: Reason[] }) {
  return (
    <span className="sch-reasons">
      {reasons.map((r) => <span key={r.text} className={`sch-reason t-${r.tone}`}>{r.text}</span>)}
    </span>
  );
}

// The client's Launch27 tags, and how the planner read the ones about cleaners, so it's clear
// why someone is missing from (or first in) the results.
export function ClientTagsPanel({ tags, name }: { tags: ClientTags; name?: string }) {
  const who = (r: ClientTags['avoid'][number]) => r.cleaners.map((c) => c.name).join(', ');
  const unread = [...tags.avoid, ...tags.prefers].filter((r) => !r.cleaners.length);
  return (
    <div className="card sch-tags">
      <span className="eyebrow">{name ? `${name}'s tags` : "Client's tags"}</span>
      {tags.tags.length ? <div className="chips">{tags.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div> : <span className="muted small">No tags on this client in Launch27.</span>}
      {tags.avoid.filter((r) => r.cleaners.length).map((r) => <p key={`a-${r.name}`} className="small sch-tag-rule"><span className="sch-reason t-warn">Not shown</span> {who(r)}: tagged "do not assign {r.name}".</p>)}
      {tags.prefers.filter((r) => r.cleaners.length).map((r) => <p key={`p-${r.name}`} className="small sch-tag-rule"><span className="sch-reason t-good">Preferred</span> {who(r)}: shown first where free.</p>)}
      {tags.female_only && <p className="small sch-tag-rule"><span className="sch-reason t-warn">Female cleaners only</span></p>}
      {unread.map((r) => <p key={`u-${r.name}`} className="small warn sch-tag-rule">No cleaner matches "{r.name}", so that tag isn't applied. Check the spelling of the tag in Launch27.</p>)}
    </div>
  );
}

export function ScheduleStatus() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['schedule', 'status'], queryFn: scheduleApi.status, refetchInterval: (q) => (q.state.data?.running ? 4000 : 60_000) });
  const refresh = useMutation({
    mutationFn: scheduleApi.refresh,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedule', 'status'] });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['schedule'] }), 5000);
    },
  });
  const s = status.data;
  if (!s) return null;
  const mins = s.taken_at ? Math.max(0, Math.round((Date.now() - new Date(s.taken_at).getTime()) / 60_000)) : null;
  return (
    <span className="muted small sch-status">
      {s.running ? 'Refreshing from Launch27…' : mins === null ? 'Not loaded yet' : `Updated ${mins === 0 ? 'just now' : `${mins} min ago`} · bookings refresh every ${s.refresh_minutes} min, cleaners' hours every ${s.full_minutes} min, and right after changes made here`}
      {s.last_error && <span className="warn"> · last refresh failed: {s.last_error}</span>}
      {!s.running && <button className="link" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh now</button>}
    </span>
  );
}
