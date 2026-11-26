import { CleanerAdjustmentCard } from '../tracker/CleanerAdjustment';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type ConversationDetail } from '../inbox/api';
import { ConversationView, DonePanel, type ComposerHandle } from '../inbox/ConversationView';
import { Avatar, Customer360 } from '../inbox/Customer360';
import { Cleaner360 } from '../inbox/Cleaner360';
import { NewConversation } from '../inbox/NewConversation';
import { ROLE_LABEL, ago, dayBucket, displayIdentity, prefs, rowTime, sinceISO, slaText, useCounts, useInboxMe, useMeta, type Since } from '../inbox/util';
import { Icon } from '../components/Icon';
import { l27 } from '../api';
import type { Booking } from '../types';
import { liveVisit, visitStatus } from '../lib/customer360';
import { fmtTime } from '../format';

// The one-stop support workspace: work list | conversation | 360.
export function InboxPage() {
  const { id } = useParams();
  const convId = id ? Number(id) : null;
  const composer = useRef<ComposerHandle>(null);
  const [params, setParams] = useSearchParams();
  // The list opens on All; Mine and Unassigned narrow it.
  const view = params.get('view') || 'all';
  const detail = useQuery({ queryKey: ['inbox', 'conversation', convId], queryFn: () => inbox.get(convId!), enabled: !!convId, refetchInterval: 5_000 });
  // Phones show one pane at a time: the list, the conversation, or the person's details.
  const [person, setPerson] = useState(false);
  useEffect(() => setPerson(false), [convId]);
  const who = detail.data?.contact?.roles?.includes('cleaner') ? 'Cleaner' : 'Customer';
  // Desktop: the details panel can be folded away to give the conversation more room. Remembered.
  const [sideHidden, setSideHiddenState] = useState(() => prefs.get<boolean>('sideHidden', false));
  const setSideHidden = (v: boolean) => { setSideHiddenState(v); prefs.set('sideHidden', v); };

  return (
    <div className={`workspace${convId ? ' has-conv' : ''}${convId && person ? ' show-person' : ''}${sideHidden ? ' side-hidden' : ''}`}>
      <WorkList view={view} setView={(v) => setParams(v === 'all' ? {} : { view: v })} activeId={convId} />
      <section className="ws-center">{convId ? <ConversationView key={convId} id={convId} composerRef={composer} onShowPerson={() => setPerson(true)} assist={detail.data ? <AssistBar detail={detail.data} onUse={(t) => composer.current?.insert(t)} /> : null} /> : <EmptyState />}</section>
      <aside className="ws-right">
        {sideHidden ? (
          <button type="button" className="ws-side-toggle" title="Show the details panel" aria-label="Show the details panel" aria-expanded={false} onClick={() => setSideHidden(false)}><Icon name="panel-open" size={16} /></button>
        ) : (
          <div className="ws-side-head">
            <span className="muted small">{detail.data ? `${who} details` : 'Details'}</span>
            <button type="button" className="ws-side-toggle" title="Hide the details panel" aria-label="Hide the details panel" aria-expanded onClick={() => setSideHidden(true)}><Icon name="panel-close" size={16} /></button>
          </div>
        )}
        <div className="ws-person-bar">
          <button type="button" className="link" onClick={() => setPerson(false)}>← Conversation</button>
          <b>{who} details</b>
        </div>
        {sideHidden && !person ? null : detail.data ? <Panel360 key={`${convId}-${detail.data.contact?.id}`} detail={detail.data} onInsert={(t) => { composer.current?.insert(t); setPerson(false); }} /> : <div className="muted small pad">Pick a conversation to see the customer or cleaner here.</div>}
      </aside>
    </div>
  );
}

function Panel360({ detail, onInsert }: { detail: ConversationDetail; onInsert: (t: string) => void }) {
  const contact = detail.contact;
  const roles = contact?.roles || [];
  const both = roles.includes('cleaner') && roles.includes('customer');
  const [tab, setTab] = useState<'customer' | 'cleaner'>(roles.includes('cleaner') ? 'cleaner' : 'customer');
  if (!contact) return <div className="muted small pad">Match this conversation to a contact to see their 360.</div>;
  const showCleaner = both ? tab === 'cleaner' : roles.includes('cleaner');
  return (
    <>
      {both && (
        <div className="tabs compact pad-x">
          <button className={tab === 'customer' ? 'tab active' : 'tab'} onClick={() => setTab('customer')}>As customer</button>
          <button className={tab === 'cleaner' ? 'tab active' : 'tab'} onClick={() => setTab('cleaner')}>As cleaner</button>
        </div>
      )}
      {showCleaner ? (
        <Cleaner360 contact={contact} conversationId={detail.conversation.id} onInsert={onInsert} />
      ) : (
        <Customer360 contact={contact} conversationId={detail.conversation.id} pinnedBookingId={detail.conversation.l27_booking_id} onInsert={onInsert} />
      )}
      <CleanerAdjustmentCard contact={contact} conversationId={detail.conversation.id} cleanerName={detail.conversation.cleaner_name} />
    </>
  );
}

function EmptyState() {
  const counts = useCounts();
  return (
    <div className="conv-empty">
      <h2>Support workspace</h2>
      <p className="muted">{counts.data ? `${counts.data.mine} open for you · ${counts.data.unassigned} unassigned · ${counts.data.breached} past their reply target` : 'Loading…'}</p>
      <p className="muted small">Channels aren't connected yet. Use the <Link to="/inbox-simulator">simulator</Link> to send test messages through routing.</p>
    </div>
  );
}

type Sort = 'newest' | 'oldest' | 'due';

const SORT_LABEL: Record<Sort, string> = { newest: 'Newest first', oldest: 'Oldest first', due: 'Reply deadline' };

function WorkList({ view, setView, activeId }: { view: string; setView: (v: string) => void; activeId: number | null }) {
  const me = useInboxMe();
  const meta = useMeta();
  const counts = useCounts();
  const navigate = useNavigate();
  const [status, setStatus] = useState('open');
  const [channel, setChannel] = useState('');
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSortState] = useState<Sort>(() => prefs.get<Sort>('sort', 'newest'));
  const [since, setSinceState] = useState<Since>(() => prefs.get<Since>('since', ''));
  const [showFilters, setShowFilters] = useState(false);
  // "New conversation": find or add the person, then text or email them.
  const [composing, setComposing] = useState(false);
  // Select: tick several conversations and mark them done together.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [closing, setClosing] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const bulk = useMutation({
    mutationFn: (d: Parameters<typeof inbox.bulkDone>[1]) => inbox.bulkDone([...picked], d),
    onSuccess: (r) => {
      setBulkMsg(`${r.done.length} marked done${r.failed.length ? `; ${r.failed.length} couldn't be: ${r.failed.map((f) => f.error).filter((e, i, a) => a.indexOf(e) === i).join('; ')}` : ''}.`);
      setPicked(new Set(r.failed.map((f) => f.id)));
      setClosing(false);
      if (!r.failed.length) setSelecting(false);
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err) => setBulkMsg((err as Error).message),
  });
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); setClosing(false); };
  const setSort = (v: Sort) => { setSortState(v); prefs.set('sort', v); };
  const setSince = (v: Since) => { setSinceState(v); prefs.set('since', v); };
  // Re-computed each minute so "today" rolls over without a reload.
  const minute = Math.floor(Date.now() / 60_000);
  const sinceAt = sinceISO(since, minute * 60_000);
  const list = useQuery({
    queryKey: ['inbox', 'list', view, status, channel, role, q, sort, sinceAt],
    queryFn: () => inbox.list({ view, status, channel: channel || undefined, role: role || undefined, q: q || undefined, sort, since: sinceAt }),
    refetchInterval: 5_000,
  });
  const primary = [
    { key: 'all', label: 'All', n: undefined, hint: 'Everything you can see' },
    { key: 'mine', label: 'Mine', n: counts.data?.mine, hint: 'Open conversations assigned to you' },
    { key: 'unassigned', label: 'Unassigned', n: counts.data?.unassigned, hint: 'Nobody owns these yet. Open one and claim it.' },
  ];
  // Attention filters only show up when there is something in them (or one is selected).
  const attention = [
    { key: 'breached', label: 'Late', n: counts.data?.breached, hint: 'Past their reply target' },
    { key: 'mentions', label: 'Mentions', n: counts.data?.mentions, hint: 'Teammates @mentioned you' },
    { key: 'needs_match', label: 'Who is this?', n: counts.data?.needs_match, hint: 'Not matched to a customer or cleaner yet' },
  ].filter((v) => !!v.n || view === v.key);
  const queueId = view.startsWith('queue:') ? view.slice(6) : '';
  const extraFilters = (status !== 'open' ? 1 : 0) + (channel ? 1 : 0) + (role ? 1 : 0);
  const now = Date.now();
  const grouped = sort !== 'due';
  const rowHref = (id: number) => `/inbox/${id}${view !== 'all' ? `?view=${encodeURIComponent(view)}` : ''}`;
  let lastBucket = '';

  return (
    <aside className="ws-left">
      <button type="button" className="ws-new" onClick={() => setComposing(true)}><Icon name="chat" size={16} /> New conversation</button>
      {composing && <NewConversation onClose={() => setComposing(false)} />}
      <div className="ws-tabs" role="tablist" aria-label="Conversations">
        {primary.map((v) => (
          <button key={v.key} role="tab" aria-selected={view === v.key} title={v.hint} className={view === v.key ? 'ws-tab active' : 'ws-tab'} onClick={() => setView(v.key)}>
            {v.label} {!!v.n && <span className="count">{v.n}</span>}
          </button>
        ))}
      </div>
      {(attention.length > 0 || (meta.data?.queues.length ?? 0) > 1) && (
        <div className="ws-attention">
          {attention.map((v) => (
            <button key={v.key} title={v.hint} className={`ws-pill ${v.key === 'breached' ? 'late' : ''} ${view === v.key ? 'active' : ''}`} onClick={() => setView(view === v.key ? 'all' : v.key)}>
              <Icon name={VIEW_ICON[v.key] || 'inbox'} size={13} /> {v.label} {!!v.n && <span className="count">{v.n}</span>}
            </button>
          ))}
          {/* One queue is just the inbox: nothing to choose between. */}
          {(meta.data?.queues.length || 0) > 1 && (
            <select className={queueId ? 'ws-queue active' : 'ws-queue'} aria-label="Queue" value={queueId} onChange={(e) => setView(e.target.value ? `queue:${e.target.value}` : 'all')}>
              <option value="">All queues</option>
              {meta.data?.queues.map((qu) => (
                <option key={qu.id} value={qu.id}>
                  {qu.name}{qu.restricted ? ' (restricted)' : ''}{counts.data?.queues[qu.id] ? ` · ${counts.data.queues[qu.id]}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="ws-filters">
        <input type="search" placeholder="Search name, number, message" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {(Object.keys(SORT_LABEL) as Sort[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
        </select>
        <select aria-label="Time range" value={since} onChange={(e) => setSince(e.target.value as Since)}>
          <option value="">Any time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <div className="ws-tools">
          <button type="button" className="ws-more" aria-expanded={showFilters} onClick={() => setShowFilters((x) => !x)}>
            <Icon name="filter" size={13} /> {showFilters ? 'Fewer filters' : 'More filters'}{extraFilters ? ` (${extraFilters})` : ''}
          </button>
          <button type="button" className="ws-more" aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : (setSelecting(true), setBulkMsg(null)))}>
            <Icon name="check" size={13} /> {selecting ? 'Cancel selecting' : 'Select'}
          </button>
        </div>
        {showFilters && (
          <>
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="snoozed">Snoozed</option>
              <option value="done">Done</option>
              <option value="all">Any status</option>
            </select>
            <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">All channels</option>
              <option value="sms">Text</option>
              <option value="email">Email</option>
              <option value="voice">Calls</option>
              <option value="chat">Chat</option>
            </select>
            <select aria-label="Contact type" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Everyone</option>
              <option value="customer">Customers</option>
              <option value="cleaner">Cleaners</option>
              <option value="applicant">Applicants</option>
            </select>
            {extraFilters > 0 && <button type="button" className="link small" onClick={() => { setStatus('open'); setChannel(''); setRole(''); }}>Reset</button>}
          </>
        )}
      </div>
      {selecting && (
        <div className="ws-bulk" role="region" aria-label="Selected conversations">
          <div className="ws-bulk-bar">
            <label className="ws-check">
              <input type="checkbox" aria-label="Select all shown" checked={!!list.data?.length && list.data.every((c) => picked.has(c.id))} onChange={(e) => setPicked(e.target.checked ? new Set(list.data?.filter((c) => c.status !== 'done').map((c) => c.id)) : new Set())} />
              <span>{picked.size} selected</span>
            </label>
            <button type="button" disabled={!picked.size || bulk.isPending} onClick={() => setClosing(true)}>Mark done</button>
          </div>
          {closing && meta.data && (
            <DonePanel initial={{}} roles={[]} meta={meta.data.dispositions} busy={bulk.isPending} onCancel={() => setClosing(false)} onSave={(d) => bulk.mutate(d)} />
          )}
        </div>
      )}
      {bulkMsg && <div className="notice small ws-bulk-msg" role="status">{bulkMsg}</div>}
      <div className="ws-list">
        {list.isLoading && <div className="muted small pad">Loading…</div>}
        {list.data?.length === 0 && (
          <div className="muted small pad">
            {view === 'mine' && me.data?.presence !== 'available'
              ? 'Nothing assigned. Set yourself to Available to receive work.'
              : view === 'mine' && counts.data?.unassigned
                ? <>Nothing assigned to you. <button type="button" className="link small" onClick={() => setView('unassigned')}>{counts.data.unassigned} unassigned</button> waiting.</>
                : since ? 'Nothing in this time range.' : 'Nothing here.'}
          </div>
        )}
        {list.data?.map((c) => {
          const sla = c.status === 'open' ? slaText(c.sla_due_at, now) : null;
          const bucket = grouped ? dayBucket(c.last_message_at, now) : '';
          const header = grouped && bucket !== lastBucket ? bucket : null;
          lastBucket = bucket;
          return (
            <Fragment key={c.id}>
              {header && <div className="ws-day">{header}</div>}
              <NavLink to={rowHref(c.id)} aria-selected={selecting ? picked.has(c.id) : undefined} className={`ws-row${c.id === activeId ? ' active' : ''}${selecting && picked.has(c.id) ? ' picked' : ''}`} onClick={(e) => { e.preventDefault(); if (selecting) toggle(c.id); else navigate(rowHref(c.id)); }}>
                {selecting && <input type="checkbox" className="ws-row-check" aria-label={`Select ${c.contact_name || displayIdentity(c.their_identity)}`} checked={picked.has(c.id)} onChange={() => toggle(c.id)} onClick={(e) => e.stopPropagation()} />}
                <Avatar name={c.contact_name || displayIdentity(c.their_identity)} size={36} />
                <div className="ws-row-body">
                  <div className="ws-row-top">
                    <span className="ws-name">
                      <span className="ws-name-text">{c.contact_name || displayIdentity(c.their_identity)}</span>
                      {c.contact_roles?.filter((r) => r !== 'customer').map((r) => <span key={r} className={`chip role-${r}`}>{ROLE_LABEL[r]}</span>)}
                      {c.needs_match && <span className="chip warn">Who is this?</span>}
                    </span>
                    <span className="muted small mono" title={`${ago(c.last_message_at, now)} ago`}>{rowTime(c.last_message_at, now)}</span>
                  </div>
                  <div className="ws-preview">{c.subject ? <b>{c.subject} · </b> : null}{c.last_preview}</div>
                  <div className="ws-row-meta">
                    <Icon name={c.channel} size={14} label={c.channel === 'sms' ? 'Text' : c.channel === 'email' ? 'Email' : c.channel === 'voice' ? 'Call' : 'Chat'} />
                    {sla && <span className={sla.tone === 'late' ? 'chip neg' : sla.tone === 'warn' ? 'chip warn' : 'chip'}>{sla.text}</span>}
                    {c.has_complaint && <span className="chip neg">Complaint</span>}
                    {c.l27_booking_id && <span className="chip">#{c.l27_booking_id}</span>}
                    {view !== 'mine' && <span className="muted small ws-owner">{c.owner_name || 'Unassigned'}</span>}
                  </div>
                </div>
              </NavLink>
            </Fragment>
          );
        })}
      </div>
    </aside>
  );
}

const VIEW_ICON: Record<string, string> = { mine: 'inbox', unassigned: 'user', mentions: 'at', breached: 'alert', needs_match: 'question', all: 'search' };

// Spots something worth telling the customer about today's visit, from the cleaner's
// en route / check-in taps, and drafts the message.
function AssistBar({ detail, onUse }: { detail: ConversationDetail; onUse: (text: string) => void }) {
  const cid = detail.contact?.l27_customer_id;
  const isCustomer = !!cid && !detail.contact?.roles?.includes('cleaner');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const visits = useQuery({
    queryKey: ['customer', String(cid), 'today', today],
    queryFn: () => l27<Booking[]>('/v1/staff/bookings', { customers: cid!, from: today, to: today }),
    enabled: isCustomer && detail.conversation.status !== 'done',
    refetchInterval: 60_000,
  });
  const b = visits.data ? liveVisit(visits.data) : null;
  if (!b) return null;
  const s = visitStatus(b);
  const who = (b.teams?.[0]?.title || 'Your cleaner').split(' ')[0];
  const firstName = (detail.contact?.name || '').split(' ')[0];
  const end = fmtTime(new Date(s.windowEnd).toISOString());
  let line: string | null = null;
  let draft = '';
  if (s.risk?.kind === 'not_checked_in') {
    line = `${who} has been en route since ${fmtTime(s.enrouteAt)} and hasn't checked in. The window ends at ${end}.`;
    draft = `Hi ${firstName}, so sorry for the wait! ${who} is on the way now (left at ${fmtTime(s.enrouteAt)}). We'll text you the moment they arrive.`;
  } else if (s.risk?.kind === 'not_enroute') {
    line = `${who} hasn't started en route yet and the window opened at ${fmtTime(new Date(s.windowStart).toISOString())}.`;
    draft = `Hi ${firstName}, thanks for your patience. We're checking in with ${who} now and will update you in a few minutes.`;
  } else if (s.stage === 'enroute') {
    line = `${who} is on the way (en route since ${fmtTime(s.enrouteAt)}).`;
    draft = `Hi ${firstName}, good news: ${who} is on the way now (left at ${fmtTime(s.enrouteAt)}).`;
  } else if (s.stage === 'arrived') {
    line = `${who} checked in at ${fmtTime(s.checkinAt)}.`;
    draft = `Hi ${firstName}, ${who} arrived at ${fmtTime(s.checkinAt)} and is getting started.`;
  }
  if (!line) return null;
  return (
    <div className={s.risk ? 'assist risk' : 'assist'} role="status">
      <Icon name="bolt" />
      <span className="grow">
        <strong>{line}</strong> Let {firstName || 'them'} know?
      </span>
      <button type="button" className="secondary" onClick={() => onUse(draft)}>
        Draft the update
      </button>
    </div>
  );
}
