import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type Channel, type Complaint, type ConversationDetail, type Disposition, type Message } from './api';
import { CHANNEL_LABEL, ROLE_LABEL, ago, displayIdentity, drafts, fillTemplate, firstName, slaText, useInboxMe, useMeta } from './util';
import { fmtDateTime, fmtTime } from '../format';
import { Icon } from '../components/Icon';
import { useActiveTeams } from '../hooks';

export interface ComposerHandle {
  insert: (text: string) => void;
}

export function ConversationView({ id, composerRef, assist, onShowPerson }: { id: number; composerRef?: React.Ref<ComposerHandle>; assist?: React.ReactNode; onShowPerson?: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['inbox', 'conversation', id], queryFn: () => inbox.get(id), refetchInterval: 5_000 });
  // One timeline per person: their texts, calls and emails together, however they reached
  // us. Email conversations open on their own thread instead: one sender often writes about
  // several things, and each email thread is its own piece of work. The choice is remembered
  // separately for email and for texts and calls.
  const isEmail = detail.data?.conversation.channel === 'email';
  const prefKey = isEmail ? 'inbox.wholeHistory.email' : 'inbox.wholeHistory';
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const stored = (() => {
    try {
      const v = localStorage.getItem(prefKey);
      return v === null ? !isEmail : v !== 'off';
    } catch {
      return !isEmail;
    }
  })();
  const whole = picked[prefKey] ?? stored;
  const hasContact = !!detail.data?.contact;
  const history = useQuery({ queryKey: ['inbox', 'history', id], queryFn: () => inbox.personHistory(id), enabled: whole && hasContact, refetchInterval: 5_000 });
  const toggleWhole = () => {
    const next = !whole;
    setPicked((p) => ({ ...p, [prefKey]: next }));
    try {
      localStorage.setItem(prefKey, next ? 'on' : 'off');
    } catch {
      /* not remembered */
    }
  };
  const me = useInboxMe();
  const meta = useMeta();
  const [panel, setPanel] = useState<null | 'done' | 'snooze' | 'assign' | 'complaint'>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['inbox'] });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setError(null);
      setPanel(null);
      refresh();
    },
    onError: (err) => setError((err as Error).message),
  });

  if (detail.isLoading) return <div className="conv-empty muted">Loading…</div>;
  if (detail.error) return <div className="conv-empty error">{(detail.error as Error).message}</div>;
  const d = detail.data!;
  const c = d.conversation;
  const sla = c.status === 'open' ? slaText(c.sla_due_at) : null;
  const mine = me.data && c.owner_id === me.data.id;

  return (
    <div className={panel ? 'conv panel-open' : 'conv'}>
      <header className="conv-header">
        <div className="conv-who">
          <div className="mobile-only conv-mobile-nav">
            <Link to="/inbox" className="conv-back">← Inbox</Link>
            {d.contact && (onShowPerson
              ? <button type="button" className="secondary conv-person" onClick={onShowPerson}>{d.contact.roles?.includes('cleaner') ? 'Cleaner' : 'Customer'} details →</button>
              : <Link to={`/contacts/${d.contact.id}`}>Profile and bookings</Link>)}
          </div>
          <h2>
            {d.contact?.name || displayIdentity(c.their_identity) || 'Unknown sender'}
            {d.contact?.roles?.map((r) => <span key={r} className={`role-badge ${r}`}>{ROLE_LABEL[r]}</span>)}
          </h2>
          <div className="muted small">
            <Icon name={c.channel} size={13} /> {CHANNEL_LABEL[c.channel]} · {displayIdentity(c.their_identity)} → {displayIdentity(c.our_identity)} · #{c.id}
            {c.subject && <> · <span className="clip">{c.subject}</span></>}
          </div>
        </div>
        <div className="conv-state">
          <span className={`status-pill ${c.status}`}>{c.status === 'snoozed' ? `Snoozed until ${fmtDateTime(c.snooze_until || undefined)}` : c.status}</span>
          {sla && <span className={`sla ${sla.tone}`} title={d.sla_policy?.name}>{sla.text}</span>}
          {c.priority >= 4 && <span className="pill late">P{c.priority}</span>}
        </div>
      </header>

      <div className="conv-toolbar">
        <span className="small">
          <CleanerField detail={d} onSave={(cleaner) => act.mutate(() => inbox.patch(id, cleaner))} /> ·{' '}
          {d.queue?.name || 'No queue'} · {d.owner ? <>Owner: <b>{d.owner.name || d.owner.email}</b>{d.owner.presence !== 'available' && <span className="muted"> ({d.owner.presence})</span>}</> : <span className="warn">Unassigned</span>}
        </span>
        <div className="actions">
          {!c.owner_id && <button onClick={() => act.mutate(() => inbox.claim(id))}>Claim</button>}
          <button className="secondary" onClick={() => setPanel(panel === 'assign' ? null : 'assign')}>Assign</button>
          {c.status !== 'done' && <button className="secondary" onClick={() => setPanel(panel === 'snooze' ? null : 'snooze')}>Snooze</button>}
          <button className="secondary" onClick={() => setPanel(panel === 'complaint' ? null : 'complaint')}>{c.complaint ? 'Complaint ●' : 'Complaint'}</button>
          {c.status !== 'done' ? (
            <button onClick={() => setPanel(panel === 'done' ? null : 'done')}>Done</button>
          ) : (
            <button className="secondary" onClick={() => act.mutate(() => inbox.patch(id, { status: 'open' }))}>Reopen</button>
          )}
        </div>
      </div>
      {error && <div className="error small">{error}</div>}

      {panel === 'done' && meta.data && <DonePanel initial={c.disposition || {}} roles={d.contact?.roles || []} meta={meta.data.dispositions} busy={act.isPending} onCancel={() => setPanel(null)} onSave={(disposition) => act.mutate(() => inbox.patch(id, { status: 'done', disposition }))} />}
      {panel === 'snooze' && <SnoozePanel onCancel={() => setPanel(null)} onSave={(until) => act.mutate(() => inbox.patch(id, { status: 'snoozed', snooze_until: until }))} />}
      {panel === 'assign' && <AssignPanel detail={d} onCancel={() => setPanel(null)} onAssign={(userId, reason) => act.mutate(() => inbox.assign(id, userId, reason))} onMove={(queueId) => act.mutate(() => inbox.patch(id, { queue_id: queueId }))} />}
      {panel === 'complaint' && <ComplaintPanel initial={c.complaint} bookingId={c.l27_booking_id} onCancel={() => setPanel(null)} onSave={(complaint) => act.mutate(() => inbox.patch(id, { complaint }))} />}
      {c.needs_match && <MatchPanel detail={d} onMatch={(contactId) => act.mutate(() => inbox.match(id, contactId))} />}

      {d.contact && (d.others.length > 0 || (history.data?.conversations || 0) > 1) && (
        <div className="tl-scope small">
          <button type="button" className={whole ? 'tab active' : 'tab'} onClick={() => !whole && toggleWhole()}>Everything with {d.contact.name?.split(' ')[0] || 'them'}</button>
          <button type="button" className={!whole ? 'tab active' : 'tab'} onClick={() => whole && toggleWhole()}>This {CHANNEL_LABEL[c.channel].toLowerCase()} thread only</button>
          {whole && <span className="muted"> Texts, calls and emails in one timeline. Your reply goes by {CHANNEL_LABEL[c.channel].toLowerCase()}.</span>}
        </div>
      )}
      <Timeline subject={c.subject} currentId={id} messages={whole && history.data ? history.data.messages.filter((m) => m.conversation_id === id || m.kind !== 'event') : d.messages} />
      {assist}

      {c.status === 'done' && c.disposition && (
        <div className="done-banner small">
          Done: {c.disposition.audience} · {c.disposition.reason} · {c.disposition.outcome}
          {c.disposition.note && <> · {c.disposition.note}</>}
        </div>
      )}
      <Composer ref={composerRef} detail={d} mine={!!mine} onSent={refresh} />
    </div>
  );
}

function Timeline({ messages, subject, currentId }: { messages: Message[]; subject?: string | null; currentId?: number }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a promise from scrollIntoView, which React would treat as a cleanup.
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  let lastDay = '';
  // An email's subject shows only when it changes: the header already names the thread, and
  // "Re: Booking" under "Booking" is the same subject.
  let lastSubject = sameSubject(subject);
  let lastOther: number | null = null;
  return (
    <div className="timeline">
      {messages.map((m) => {
        const day = dayHeading(m.created_at);
        const sep = day !== lastDay ? <div key={`d-${m.id}`} className="tl-day"><span>{day}</span></div> : null;
        lastDay = day;
        let showSubject = false;
        if (m.kind === 'message' && m.channel === 'email' && m.subject) {
          const s = sameSubject(m.subject);
          showSubject = !!s && s !== lastSubject;
          lastSubject = s || lastSubject;
        }
        // In "Everything with them", say which other conversation a message belongs to, so a
        // reply here is not mistaken for an answer to it.
        const other = currentId && m.conversation_id && m.conversation_id !== currentId && m.kind !== 'event';
        const tag = other && m.conversation_id !== lastOther ? (
          <div key={`o-${m.id}`} className="tl-other">
            From another conversation{m.subject ? <>: <b>{m.subject}</b></> : ''} · <Link to={`/inbox/${m.conversation_id}`}>Open</Link>
          </div>
        ) : null;
        lastOther = other ? m.conversation_id : null;
        return [sep, tag, renderMessage(m, showSubject && !other)];
      })}
      <div ref={end} />
    </div>
  );
}

function dayHeading(iso: string) {
  const d = new Date(iso);
  const key = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (key(d) === key(today)) return 'Today';
  if (key(d) === key(yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
}

function deliveryLabel(state: string | null) {
  switch (state) {
    case 'not_connected':
      return 'not sent: channel not connected';
    case 'sandbox':
      return 'sandbox: not sent to customer';
    case 'sending':
      return 'sending…';
    case 'queued':
      return 'accepted, waiting for the carrier';
    case 'delivered':
      return 'delivered';
    case 'failed':
      return 'not sent';
    case 'unknown':
      return 'status unknown';
    default:
      return state || '';
  }
}

// A long message starts as a preview (about 8 lines, faded) that the agent can open.
// Measured, so short messages look exactly as before and only real overflow gets the button.
function LongText({ text, className = 'pre' }: { text: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 4);
  }, [text, open]);
  return (
    <>
      <div ref={box} className={`${className}${open ? '' : ' clamp'}${long && !open ? ' faded' : ''}`}>{text}</div>
      {(long || open) && (
        <button type="button" className="link small show-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

// "Re: RE: Fwd: Booking  next week" and "booking next week" are the same subject.
export function sameSubject(s?: string | null) {
  return String(s || '').replace(/^\s*((re|fw|fwd|tr|aw|sv)(\[\d+\])?\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function renderMessage(m: Message, showSubject = true) {
        if (m.kind === 'event') {
          return (
            <div key={m.id} className="tl-event">
              <span>{m.body}</span> <span className="muted">{ago(m.created_at)}</span>
            </div>
          );
        }
        if (m.kind === 'note') {
          return (
            <div key={m.id} className="tl-msg note">
              <div className="tl-meta"><Icon name="note" size={13} /> Internal note · {m.author_name} · {fmtTime(m.created_at)}</div>
              <LongText text={m.body || ''} />
            </div>
          );
        }
        if (m.kind === 'call') {
          return (
            <div key={m.id} className={`tl-msg call ${m.direction}`}>
              <div className="tl-meta"><Icon name="voice" size={13} /> {m.body} · {fmtTime(m.created_at)}</div>
              {m.meta?.recording_url && <a href={String(m.meta.recording_url)} target="_blank" rel="noreferrer" className="small">Recording</a>}
            </div>
          );
        }
        const notSent = m.delivery_state === 'not_connected' || m.delivery_state === 'failed';
        return (
          <div key={m.id} className={`tl-msg ${m.direction}`}>
            {showSubject && m.subject && m.channel === 'email' && <div className="tl-subject">{m.subject}</div>}
            <LongText text={m.body || ''} />
            {m.channel === 'email' && <EmailExtras m={m} />}
            <div className="tl-meta">
              {m.channel && <Icon name={m.channel} size={12} />} {m.channel ? CHANNEL_LABEL[m.channel] : ''} · {m.direction === 'out' ? m.author_name || 'Agent' : displayIdentity(m.from_addr)} · {fmtTime(m.created_at)}
              {m.direction === 'out' && !!m.meta?.via && <span className="muted"> · sent from {String(m.meta.via)}</span>}
              {m.direction === 'out' && <span className={notSent ? 'delivery bad' : 'delivery'}> · {deliveryLabel(m.delivery_state)}</span>}
              {m.direction === 'out' && m.delivery_state === 'failed' && m.channel === 'sms' && m.meta?.note && <div className="error small">{String(m.meta.note)}</div>}
            </div>
          </div>
        );
}

// Email details under a message: who else was copied, attachment names, the quoted history.
const fileSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);

// What kind of file it is, from its name: a short label and a colour for the badge.
const FILE_KINDS: [RegExp, string, string][] = [
  [/\.pdf$/i, 'PDF', 'pdf'],
  [/\.(docx?|rtf|odt|pages)$/i, 'DOC', 'doc'],
  [/\.(xlsx?|csv|ods|numbers)$/i, 'XLS', 'xls'],
  [/\.(pptx?|key)$/i, 'PPT', 'ppt'],
  [/\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i, 'IMG', 'img'],
  [/\.(zip|rar|7z|gz)$/i, 'ZIP', 'zip'],
  [/\.(mp3|m4a|wav|ogg)$/i, 'AUD', 'aud'],
  [/\.(mp4|mov|avi|webm)$/i, 'VID', 'vid'],
  [/\.(txt|md|log)$/i, 'TXT', 'txt'],
];
export const fileKind = (name: string) => {
  const hit = FILE_KINDS.find(([re]) => re.test(name));
  return hit ? { label: hit[1], cls: hit[2] } : { label: (name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase(), cls: 'other' };
};

// A file shown as a small card: what kind it is (or a thumbnail), its name and size.
function FileCard({ name, size, thumb, note, action }: { name: string; size: number; thumb?: string | null; note?: string | null; action?: React.ReactNode }) {
  const kind = fileKind(name);
  return (
    <span className="file-card" title={name}>
      {thumb ? <img className="file-thumb" src={thumb} alt="" /> : <span className={`file-badge ${kind.cls}`} aria-hidden="true">{kind.label}</span>}
      <span className="file-text">
        <span className="file-name">{name}</span>
        <span className="file-size">{note || fileSize(size)}</span>
      </span>
      {action}
    </span>
  );
}

// One file on an email in the timeline. Pressing it fetches the file from the mailbox and saves it.
function FileChip({ messageId, index, file, canGet }: { messageId: number; index: number; file: { filename: string; size: number }; canGet: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const get = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/messages/${messageId}/attachments/${index}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Could not get the file (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!canGet) return <span className="file-card-wrap off" title="Recorded on a test message; there is no file to download"><FileCard name={file.filename} size={file.size} note={`${fileSize(file.size)} · test message, no file kept`} /></span>;
  return (
    <span className="file-card-wrap">
      <button type="button" className="file-card-btn" disabled={busy} onClick={get} aria-label={`Download ${file.filename}`}>
        <FileCard name={file.filename} size={file.size} note={busy ? 'Downloading…' : error ? null : `${fileSize(file.size)} · Download`} action={<span className="file-act" aria-hidden="true"><Icon name="download" size={16} /></span>} />
      </button>
      {error && <span className="error small file-error">{error} <button type="button" className="link small" onClick={get}>Try again</button></span>}
    </span>
  );
}

// A file picked for an email that has not been sent yet. Pictures show as a thumbnail.
function PickedFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/') || file.size > 12 * 1024 * 1024) return undefined;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <FileCard name={file.name} size={file.size} thumb={thumb} action={<button type="button" className="file-remove" aria-label={`Remove ${file.name}`} title="Remove" onClick={onRemove}><Icon name="close" size={14} /></button>} />;
}

function EmailExtras({ m }: { m: Message }) {
  const [open, setOpen] = useState(false);
  const cc = Array.isArray(m.meta?.cc) ? (m.meta.cc as string[]) : [];
  const files = Array.isArray(m.meta?.attachments) ? (m.meta.attachments as { filename: string; size: number }[]) : [];
  const full = typeof m.meta?.full_body === 'string' ? m.meta.full_body : null;
  if (!cc.length && !files.length && !full && !(m.delivery_state === 'failed' && m.meta?.note)) return null;
  return (
    <div className="small muted email-extras">
      {cc.length > 0 && <div>Cc: {cc.join(', ')}</div>}
      {files.length > 0 && (
        <div className="email-files">
          {files.map((f, i) => <FileChip key={`${i}-${f.filename}`} messageId={m.id} index={i} file={f} canGet={!!m.meta?.gmail_id} />)}
        </div>
      )}
      {m.delivery_state === 'failed' && m.meta?.note && <div className="error small">Not sent: {String(m.meta.note)}</div>}
      {full && (
        <>
          <button type="button" className="link small" onClick={() => setOpen(!open)}>{open ? 'Hide earlier messages' : 'Show earlier messages in this email'}</button>
          {open && <LongText text={full} className="pre quoted" />}
        </>
      )}
    </div>
  );
}

const MAX_FILES = 10;
const MAX_FILES_BYTES = 18 * 1024 * 1024;
// A picked file as the server takes it: its name, kind and bytes (base64).
const toAttachment = (f: File) =>
  new Promise<{ filename: string; type: string; data: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${f.name}`));
    reader.onload = () => resolve({ filename: f.name, type: f.type || 'application/octet-stream', data: String(reader.result).split(',')[1] || '' });
    reader.readAsDataURL(f);
  });

const Composer = forwardRef<ComposerHandle, { detail: ConversationDetail; mine: boolean; onSent: () => void }>(function Composer({ detail, onSent }, ref) {
  const c = detail.conversation;
  const meta = useMeta();
  const location = useLocation();
  const key = `conv:${c.id}`;
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  // Started from "New conversation" and nothing in it yet: the draft is kept on the server,
  // so the conversation shows in the inbox only once something is written.
  const startedEmpty = c.routed_by === 'Started by agent' && !detail.messages.some((m) => m.conversation_id === c.id && ['message', 'note', 'call'].includes(m.kind));
  const [text, setText] = useState(() => drafts.get(key) || (startedEmpty ? c.draft : null) || (location.state as { prefill?: string } | null)?.prefill || '');
  const [channel, setChannel] = useState<Channel>(c.channel === 'voice' || c.channel === 'chat' ? (detail.contact?.identities.some((i) => i.kind === 'phone') ? 'sms' : 'email') : c.channel);
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sendKey = useRef<string | null>(null);
  // Files to go with an email. Kept in the page until sent; about 18 MB fits in one email.
  const [files, setFiles] = useState<File[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  // Dragging a file over the reply box shows where to drop it.
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // Said once when files moved the reply from Text to Email.
  const [switched, setSwitched] = useState(false);
  const filesBytes = files.reduce((n, f) => n + f.size, 0);
  const tooBig = filesBytes > MAX_FILES_BYTES;
  const [fileNote, setFileNote] = useState<string | null>(null);
  const addFiles = (list: FileList | File[] | null) => {
    const add = [...(list || [])].filter((f) => f.size > 0);
    if (!add.length) return;
    sendKey.current = null; // different files: a new message
    if (mode !== 'reply') setMode('reply');
    if (channel !== 'email') { setChannel('email'); setTo(''); setFrom(''); setSwitched(true); }
    setFiles((cur) => {
      const next = [...cur, ...add.filter((f) => !cur.some((x) => x.name === f.name && x.size === f.size))];
      setFileNote(next.length > MAX_FILES ? `One email takes up to ${MAX_FILES} files; the first ${MAX_FILES} were kept.` : null);
      return next.slice(0, MAX_FILES);
    });
  };
  const removeFile = (i: number) => {
    sendKey.current = null;
    setFiles((cur) => cur.filter((_, j) => j !== i));
  };
  const hasFiles = (e: React.DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
  const area = useRef<HTMLTextAreaElement>(null);

  // A conversation just started from "New conversation": the cursor is already in the reply box.
  useEffect(() => {
    if (startedEmpty) area.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the conversation opens
  }, []);

  useImperativeHandle(ref, () => ({
    insert: (t: string) => {
      setText((cur) => (cur ? `${cur}${cur.endsWith(' ') ? '' : ' '}${t}` : t));
      setMode('reply');
      area.current?.focus();
    },
  }));
  useEffect(() => {
    drafts.set(key, text);
  }, [key, text]);
  const savedDraft = useRef(c.draft || '');
  useEffect(() => {
    if (!startedEmpty || mode !== 'reply' || text === savedDraft.current) return;
    const t = setTimeout(() => {
      savedDraft.current = text;
      inbox.saveDraft(c.id, text).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [startedEmpty, mode, text, c.id]);

  const kind = channel === 'email' ? 'email' : 'phone';
  const targets = (detail.contact?.identities || []).filter((i) => i.kind === kind);
  const defaultTo = channel === c.channel ? c.their_identity : targets[0]?.value;
  const target = to || defaultTo || '';
  const optedOut = channel === 'sms' && targets.find((i) => i.value === target)?.opted_out;
  const fromOptions = channel === 'email' ? meta.data?.identities.email : meta.data?.identities.sms;
  const sender = from || (channel === c.channel ? c.our_identity : fromOptions?.[0]) || '';
  const connected = meta.data?.connected_channels.includes(channel);
  const sandboxed = meta.data?.channels?.[channel === 'email' ? 'email' : 'sms']?.state === 'sandbox';
  // If email is made read-only (channels.js), nothing can be sent by email: locked until the server says it can.
  const emailLocked = mode === 'reply' && channel === 'email' && meta.data?.channels?.email?.read_only !== false;
  // Files go by email, so they can't be added while email can't be sent.
  const attachLocked = meta.data?.channels?.email?.read_only !== false;
  // A new email (or a conversation started without one) needs a subject line.
  const needsSubject = channel === 'email' && (channel !== c.channel || !c.subject);

  // "/" opens canned replies; type to filter.
  const slash = mode === 'reply' && /(^|\s)\/(\w*)$/.exec(text);
  const canned = useMemo(() => {
    if (!slash || !meta.data) return [];
    const q = slash[2].toLowerCase();
    return meta.data.canned.filter((x) => (!x.channels.length || x.channels.includes(channel)) && (x.shortcut.includes(q) || x.title.toLowerCase().includes(q))).slice(0, 6);
  }, [slash, meta.data, channel]);
  const pick = (body: string) => {
    const filled = fillTemplate(body, { first_name: firstName(detail.contact) });
    setText((cur) => cur.replace(/(^|\s)\/\w*$/, `$1${filled}`));
    area.current?.focus();
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'note') await inbox.note(c.id, text);
      else {
        // One key per message: if this request is repeated (double click, retry after a network
        // error), the server returns the first one instead of texting the customer twice.
        sendKey.current ||= crypto.randomUUID();
        const attachments = channel === 'email' && files.length ? await Promise.all(files.map(toAttachment)) : undefined;
        await inbox.reply(c.id, { body: text, channel, to: target, from: sender, subject: channel === 'email' && subject ? subject : undefined, idempotency_key: sendKey.current, attachments });
        sendKey.current = null;
      }
      setText('');
      setFiles([]);
      setFileNote(null);
      setSwitched(false);
      drafts.set(key, '');
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // eslint-disable-next-line no-control-regex -- detecting non-GSM (non-ASCII) characters
  const segments = channel === 'sms' ? Math.max(1, Math.ceil(text.length / (/[^\x00-\x7F]/.test(text) ? 67 : 153))) : 0;

  return (
    <div
      className={`composer${mode === 'note' ? ' note-mode' : ''}${dragging ? ' dragging' : ''}`}
      onDragEnter={(e) => { if (!hasFiles(e) || attachLocked) return; e.preventDefault(); dragDepth.current += 1; setDragging(true); }}
      onDragOver={(e) => { if (hasFiles(e) && !attachLocked) e.preventDefault(); }}
      onDragLeave={(e) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={(e) => { if (!hasFiles(e) || attachLocked) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(e.dataTransfer.files); }}
    >
      <div className="composer-tabs">
        {(['sms', 'email'] as const).map((ch) => (
          <button key={ch} type="button" role="tab" aria-selected={mode === 'reply' && channel === ch} className={mode === 'reply' && channel === ch ? 'tab active' : 'tab'} onClick={() => { setMode('reply'); if (channel !== ch) { setChannel(ch); setTo(''); setFrom(''); } }}>
            <Icon name={ch} /> {ch === 'sms' ? 'Text' : 'Email'}
          </button>
        ))}
        <button type="button" role="tab" aria-selected={mode === 'note'} className={mode === 'note' ? 'tab active note' : 'tab'} onClick={() => setMode('note')}><Icon name="note" /> Internal note</button>
        {mode === 'reply' && (
          <div className="composer-route small">
            to
            {targets.length || defaultTo ? (
              <select value={target} onChange={(e) => setTo(e.target.value)}>
                {target && !targets.some((t) => t.value === target) && <option value={target}>{displayIdentity(target)}</option>}
                {targets.map((t) => <option key={t.id} value={t.value}>{displayIdentity(t.value)}{t.opted_out ? ' (STOP)' : ''}</option>)}
              </select>
            ) : (
              // Nothing on file for this channel: type where it should go.
              <input className="composer-to" type={channel === 'email' ? 'email' : 'tel'} inputMode={channel === 'email' ? 'email' : 'tel'} autoComplete="off" placeholder={channel === 'email' ? 'Their email address' : 'Their mobile number'} aria-label={channel === 'email' ? 'Email address to send to' : 'Number to text'} value={to} onChange={(e) => setTo(e.target.value)} />
            )}
            from
            <select value={sender} onChange={(e) => setFrom(e.target.value)}>
              {sender && !fromOptions?.includes(sender) && <option value={sender}>{displayIdentity(sender)}</option>}
              {fromOptions?.map((f) => <option key={f} value={f}>{displayIdentity(f)}</option>)}
            </select>
          </div>
        )}
      </div>
      {emailLocked && <div className="notice small" role="status">Email is read-only: emails can't be sent from this platform. Reply by text, or add an internal note.</div>}
      {mode === 'reply' && needsSubject && !emailLocked && <input className="full" placeholder="Subject" aria-label="Email subject" value={subject} onChange={(e) => setSubject(e.target.value)} />}
      <div className="composer-box">
        <textarea
          ref={area}
          rows={4}
          value={text}
          placeholder={mode === 'note' ? 'Only your team sees this. @name to notify someone.' : 'Write a reply…'}
          onChange={(e) => {
            sendKey.current = null; // edited: a new message
            setText(e.target.value);
          }}
          onPaste={(e) => {
            // A pasted screenshot or copied file becomes an attachment; pasted text stays text.
            const pasted = [...(e.clipboardData?.files || [])];
            if (pasted.length && !attachLocked && mode === 'reply') { e.preventDefault(); addFiles(pasted.map((f) => (f.name === 'image.png' ? new File([f], `Screenshot ${new Date().toLocaleString('en-CA', { hour12: false }).replace(/[/:,]/g, '-').replace(/\s+/g, ' ')}.png`, { type: f.type }) : f))); }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !busy && !optedOut && !emailLocked) send();
          }}
        />
        {!!canned.length && (
          <div className="canned-pop">
            {canned.map((x) => (
              <button key={x.id} className="canned-item" onMouseDown={(e) => { e.preventDefault(); pick(x.body); }}>
                <b>/{x.shortcut}</b> {x.title}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <div className="error small">{error}</div>}
      {optedOut && <div className="error small">This number replied STOP. Texts are blocked until they text START.</div>}
      <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      {mode === 'reply' && files.length > 0 && (
        <div className="composer-files">
          <div className="composer-files-head">
            <b>{files.length} file{files.length === 1 ? '' : 's'} attached</b>
            <span className={tooBig ? 'file-meter over' : 'file-meter'} title={`${fileSize(filesBytes)} of about 18 MB`}><span style={{ width: `${Math.min(100, (filesBytes / MAX_FILES_BYTES) * 100)}%` }} /></span>
            <span className={tooBig ? 'error small' : 'muted small'}>{fileSize(filesBytes)} of 18 MB</span>
            <button type="button" className="link small" onClick={() => { sendKey.current = null; setFiles([]); setFileNote(null); }}>Remove all</button>
          </div>
          <div className="file-grid">
            {files.map((f, i) => <PickedFile key={`${f.name}-${f.size}`} file={f} onRemove={() => removeFile(i)} />)}
            {files.length < MAX_FILES && <button type="button" className="file-add" onClick={() => picker.current?.click()}><Icon name="clip" size={15} /> Add more</button>}
          </div>
          {tooBig && <div className="error small">Too large to send: one email carries about 18 MB. Remove a file, or send a link to it instead.</div>}
          {fileNote && <div className="muted small">{fileNote}</div>}
          {switched && <div className="muted small">Files can't go by text, so this reply will be sent as an email.</div>}
          {channel !== 'email' && <div className="error small">Files can only be sent by email: switch to Email to send them, or they stay here.</div>}
        </div>
      )}
      {dragging && <div className="composer-drop" aria-hidden="true"><Icon name="clip" size={22} /><b>Drop to attach</b><span>{channel === 'email' ? 'Up to 10 files, 18 MB together' : 'The reply will be sent as an email'}</span></div>}
      <div className="composer-foot">
        {mode === 'reply' && !attachLocked && (
          <button type="button" className="composer-attach" onClick={() => picker.current?.click()} title="Attach files (or drop them here, or paste a screenshot)" aria-label="Attach files">
            <Icon name="clip" size={18} />
            <span className="composer-attach-label">Attach</span>
            {files.length > 0 && <span className="composer-attach-count">{files.length}</span>}
          </button>
        )}
        <span className="muted small composer-hint">
          {mode === 'reply' && !connected && `${CHANNEL_LABEL[channel]} isn't connected yet: replies are saved, not sent.`}
          {mode === 'reply' && connected && sandboxed && !emailLocked && 'Sandbox: replies are recorded here, not sent to the customer.'}
          {mode === 'reply' && channel === 'sms' && text && <span className="mono"> {text.length} chars · {segments} text{segments === 1 ? '' : 's'}</span>}
          {!text && <span className="composer-keys"> Type <span className="kbd">/</span> for saved replies · <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> to send</span>}
        </span>
        <button disabled={busy || !text.trim() || !!optedOut || emailLocked || (mode === 'reply' && channel === 'email' && tooBig) || (mode === 'reply' && needsSubject && !subject.trim())} title={emailLocked ? 'Email is read-only' : mode === 'reply' && needsSubject && !subject.trim() ? 'Add a subject first' : undefined} className={mode === 'note' ? 'note-btn' : ''} onClick={send}>
          {mode !== 'note' && <Icon name="send" />}
          {busy ? (mode === 'reply' && channel === 'email' && files.length ? `Sending ${files.length} file${files.length === 1 ? '' : 's'}…` : 'Saving…') : mode === 'note' ? 'Add note' : 'Send'}
        </button>
      </div>
    </div>
  );
});

export function DonePanel({ initial, roles, meta, busy, onCancel, onSave }: { initial: Disposition; roles: string[]; meta: { audience: string[]; reason: string[]; outcome: string[]; cancellationReasons: string[] }; busy: boolean; onCancel: () => void; onSave: (d: Disposition) => void }) {
  const guess = roles.includes('cleaner') ? 'Cleaner' : roles.includes('applicant') ? 'Applicant' : roles.includes('customer') ? 'Customer' : undefined;
  const [d, setD] = useState<Disposition>({ audience: guess, ...initial });
  const set = (k: keyof Disposition) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setD({ ...d, [k]: e.target.value || undefined });
  return (
    <div className="inline-panel">
      <div className="grid-3">
        <label>Who<select value={d.audience || ''} onChange={set('audience')}><option value="">Pick…</option>{meta.audience.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Reason<select value={d.reason || ''} onChange={set('reason')}><option value="">Pick…</option>{meta.reason.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Outcome<select value={d.outcome || ''} onChange={set('outcome')}><option value="">Pick…</option>{meta.outcome.map((x) => <option key={x}>{x}</option>)}</select></label>
      </div>
      {d.reason === 'Cancellation' && (
        <label>Cancellation reason<select value={d.cancellation_reason || ''} onChange={set('cancellation_reason')}><option value="">Pick…</option>{meta.cancellationReasons.map((x) => <option key={x}>{x}</option>)}</select></label>
      )}
      <label>Note (optional)<input className="full" value={d.note || ''} onChange={set('note')} /></label>
      <div className="actions end">
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button disabled={busy || !d.audience || !d.reason || !d.outcome} onClick={() => onSave(d)}>Mark done</button>
      </div>
    </div>
  );
}

function SnoozePanel({ onCancel, onSave }: { onCancel: () => void; onSave: (iso: string) => void }) {
  const opts = [
    ['1 hour', 60],
    ['3 hours', 180],
    ['Tomorrow 9am', -1],
    ['2 days', 2 * 24 * 60],
  ] as const;
  const [custom, setCustom] = useState('');
  const at = (mins: number) => {
    if (mins >= 0) return new Date(Date.now() + mins * 60_000).toISOString();
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t.toISOString();
  };
  return (
    <div className="inline-panel">
      <div className="actions">
        {opts.map(([label, mins]) => <button key={label} className="secondary" onClick={() => onSave(at(mins))}>{label}</button>)}
        <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button disabled={!custom} onClick={() => onSave(new Date(custom).toISOString())}>Snooze</button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
      <div className="muted small">It comes back to you at that time, or sooner if they reply. The reply target pauses meanwhile.</div>
    </div>
  );
}

function AssignPanel({ detail, onCancel, onAssign, onMove }: { detail: ConversationDetail; onCancel: () => void; onAssign: (userId: number | null, reason?: string) => void; onMove: (queueId: number) => void }) {
  const users = useQuery({ queryKey: ['inbox', 'users'], queryFn: inbox.users });
  const meta = useMeta();
  const [reason, setReason] = useState('');
  return (
    <div className="inline-panel">
      <div className="grid-2 tight">
        <div>
          <div className="small muted">Assign to</div>
          <div className="assign-list">
            {users.data?.map((u) => (
              <button key={u.id} className="assign-item" onClick={() => onAssign(u.id, reason || undefined)}>
                <span className={`presence-dot ${u.presence}`} /> {u.name || u.email} <span className="muted small">{u.open_count} open</span>
              </button>
            ))}
            {detail.conversation.owner_id && <button className="assign-item" onClick={() => onAssign(null, reason || undefined)}>↩ Back to the queue</button>}
          </div>
          <input className="full" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div>
          <div className="small muted">Move to queue</div>
          <div className="assign-list">
            {meta.data?.queues.map((q) => (
              <button key={q.id} className="assign-item" disabled={q.id === detail.conversation.queue_id} onClick={() => onMove(q.id)}>
                {q.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <button className="link" onClick={onCancel}>Close</button>
    </div>
  );
}

// Which cleaner this conversation is about. Defaults from the linked booking; feeds the
// complaints count on Cleaner reports when the conversation is a complaint.
const stripCodes = (t: string) => t.replace(/^\s*(on\s*hold\s*)?(\s*\([^)]*\))*\s*/i, '').trim() || t;
function CleanerField({ detail, onSave }: { detail: ConversationDetail; onSave: (c: { cleaner_id: number | null; cleaner_name: string | null }) => void }) {
  const c = detail.conversation;
  const [editing, setEditing] = useState(false);
  const teams = useActiveTeams();
  const suggested = !c.cleaner_id ? detail.cleaner_from_booking : null;
  if (editing) {
    const list = (teams.data || []).map((t) => ({ id: t.id, name: stripCodes(t.title) })).sort((a, b) => a.name.localeCompare(b.name));
    return (
      <label className="conv-cleaner">Cleaner{' '}
        <select autoFocus value={c.cleaner_id ?? ''} onBlur={() => setEditing(false)} onChange={(e) => { const t = list.find((x) => x.id === Number(e.target.value)); onSave({ cleaner_id: t ? t.id : null, cleaner_name: t ? t.name : null }); setEditing(false); }}>
          <option value="">None</option>
          {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
    );
  }
  return (
    <span className="conv-cleaner">
      Cleaner: {c.cleaner_id ? <b>{c.cleaner_name || `#${c.cleaner_id}`}</b> : suggested ? <><span className="muted">{suggested.name} (from booking)</span> <button className="link small" onClick={() => onSave({ cleaner_id: suggested.id, cleaner_name: suggested.name })}>Use</button></> : <span className="muted">none</span>}
      {' '}<button className="link small" onClick={() => setEditing(true)}>{c.cleaner_id ? 'Change' : 'Set'}</button>
    </span>
  );
}

function ComplaintPanel({ initial, bookingId, onCancel, onSave }: { initial: Complaint | null; bookingId: number | null; onCancel: () => void; onSave: (c: Complaint | null) => void }) {
  const [c, setC] = useState<Complaint>(initial || { booking_id: bookingId, status: 'open', outcome: 'pending' });
  return (
    <div className="inline-panel">
      <div className="grid-3">
        <label>Booking #<input value={c.booking_id ?? ''} onChange={(e) => setC({ ...c, booking_id: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>Cleaner<input value={c.cleaner || ''} placeholder="Set with Cleaner above" onChange={(e) => setC({ ...c, cleaner: e.target.value })} /></label>
        <label>Outcome<select value={c.outcome} onChange={(e) => setC({ ...c, outcome: e.target.value as Complaint['outcome'] })}>{['pending', 'return clean', 'credit', 'refund', 'none'].map((o) => <option key={o}>{o}</option>)}</select></label>
      </div>
      <label>What went wrong<textarea rows={2} value={c.issue || ''} onChange={(e) => setC({ ...c, issue: e.target.value })} /></label>
      <div className="grid-3">
        <label>Cost to us ($)<input type="number" value={c.monetary_impact ?? ''} onChange={(e) => setC({ ...c, monetary_impact: e.target.value ? Number(e.target.value) : null })} /></label>
        <label>Status<select value={c.status} onChange={(e) => setC({ ...c, status: e.target.value as Complaint['status'] })}><option value="open">open</option><option value="resolved">resolved</option></select></label>
      </div>
      <div className="actions end">
        {initial && <button className="link" onClick={() => onSave(null)}>Remove complaint</button>}
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button onClick={() => onSave(c)}>Save complaint</button>
      </div>
    </div>
  );
}

function MatchPanel({ detail, onMatch }: { detail: ConversationDetail; onMatch: (contactId: number) => void }) {
  const [q, setQ] = useState('');
  const found = useQuery({ queryKey: ['inbox', 'contacts', q], queryFn: () => inbox.findContacts(q), enabled: q.length >= 2 });
  const list = q.length >= 2 ? found.data || [] : detail.candidates;
  return (
    <div className="inline-panel warn-panel">
      <div className="small"><b>Who is this?</b> {displayIdentity(detail.conversation.their_identity)} matches {detail.candidates.length || 'no'} contacts. Pick the right person; nothing is merged automatically.</div>
      <input className="full" placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="assign-list">
        {list.map((c) => (
          <button key={c.id} className="assign-item" onClick={() => onMatch(c.id)}>
            {c.name || 'Unnamed'} {c.roles?.map((r) => <span key={r} className={`role-badge ${r}`}>{ROLE_LABEL[r]}</span>)}
          </button>
        ))}
      </div>
      <div className="muted small">Not listed? Open their Launch27 customer or cleaner page and use "Message" to create the contact.</div>
    </div>
  );
}
