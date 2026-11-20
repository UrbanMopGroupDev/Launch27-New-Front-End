// "New conversation": find the person (or add them), pick Text or Email, start writing.
// One box to type in. People already in the inbox come first, then customers and cleaners
// from Launch27; a phone number or email nobody knows offers a new contact. If email is ever
// made read-only again (channels.js), only Text can start a conversation.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { inbox, type Channel, type Contact, type Role, type SuggestedContact } from './api';
import { Avatar } from './Customer360';
import { ROLE_LABEL, displayIdentity, useMeta } from './util';
import { Icon } from '../components/Icon';
import { l27 } from '../api';
import type { Customer, Team } from '../types';

type Ch = 'sms' | 'email';
// Someone to start with: already a contact here, or a customer / cleaner in Launch27.
interface Person {
  key: string;
  name: string;
  roles: Role[];
  phone: string | null;
  email: string | null;
  contactId?: number;
  customerId?: number;
  teamId?: number;
  from: 'inbox' | 'bookings';
  /** For suggestions: when and how they were last reached, or how often. */
  hint?: string;
  /** The channel last used with them: its button is the filled one. */
  prefer?: Ch;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const looksLikeEmail = (s: string) => EMAIL.test(s.trim());
const looksLikePhone = (s: string) => { const d = s.replace(/\D/g, ''); return /^[\d\s()+.-]+$/.test(s.trim()) && (d.length === 10 || (d.length === 11 && d.startsWith('1'))); };
const KINDS: { label: string; roles: Role[] }[] = [{ label: 'Customer', roles: ['customer'] }, { label: 'Cleaner', roles: ['cleaner'] }, { label: 'Job applicant', roles: ['applicant'] }, { label: 'Someone else', roles: [] }];

// "5 minutes ago", "yesterday", "3 weeks ago": how people say it.
function howLongAgo(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'} ago`;
  if (mins < 2) return 'just now';
  if (mins < 60) return n(mins, 'minute');
  if (mins < 24 * 60) return n(Math.round(mins / 60), 'hour');
  const days = Math.round(mins / (24 * 60));
  if (days === 1) return 'yesterday';
  if (days < 14) return n(days, 'day');
  if (days < 60) return n(Math.round(days / 7), 'week');
  return n(Math.round(days / 30), 'month');
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function NewConversation({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const meta = useMeta();
  // Email can't be started while it is read-only (Support settings → Channels says so).
  const emailLocked = meta.data?.channels?.email?.read_only !== false;
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 200);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // A person picked who has no number (or no address) on file: ask for it right there.
  const [missing, setMissing] = useState<{ person: Person; channel: Ch; value: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const on = term.length >= 2;
  const here = useQuery({ queryKey: ['inbox', 'people', term], queryFn: () => inbox.findContacts(term), enabled: on, staleTime: 15_000 });
  const customers = useQuery({ queryKey: ['new-conv', 'customers', term], queryFn: () => l27<Customer[]>('/v1/staff/customers', { query: term, limit: 6 }).catch(() => [] as Customer[]), enabled: on, staleTime: 60_000, retry: false });
  const cleaners = useQuery({ queryKey: ['new-conv', 'cleaners', term], queryFn: () => l27<Team[]>('/v1/staff/teams', { query: term, limit: 6, filter: 'active' }).catch(() => [] as Team[]), enabled: on, staleTime: 60_000, retry: false });

  // Before anything is typed: who you were last in touch with, and who the team contacts most.
  const suggested = useQuery({ queryKey: ['inbox', 'people-suggested'], queryFn: inbox.suggested, staleTime: 60_000 });
  const suggestions = useMemo(() => {
    const WAY: Partial<Record<Channel, string>> = { sms: 'Texted', email: 'Emailed', voice: 'Call' };
    const of = (c: SuggestedContact, often: boolean): Person => {
      const phone = c.identities.find((i) => i.kind === 'phone' && !i.opted_out)?.value || c.identities.find((i) => i.kind === 'phone')?.value || null;
      const email = c.identities.find((i) => i.kind === 'email')?.value || null;
      const last = `${WAY[c.last_channel] || 'Contacted'} ${howLongAgo(c.last_at)}`;
      return {
        key: `s${c.id}`, name: c.name || displayIdentity(c.identities[0]?.value) || 'Unnamed', roles: c.roles || [], phone, email, contactId: c.id, from: 'inbox',
        hint: often && c.times ? `${c.times} times in the last 3 months · ${last.toLowerCase()}` : last,
        prefer: c.last_channel === 'email' && email && !emailLocked ? 'email' : phone ? 'sms' : email && !emailLocked ? 'email' : undefined,
      };
    };
    return { recent: (suggested.data?.recent || []).map((c) => of(c, false)), frequent: (suggested.data?.frequent || []).map((c) => of(c, true)) };
  }, [suggested.data, emailLocked]);

  const people = useMemo(() => {
    const mine: Person[] = (here.data || []).map((c: Contact) => ({
      key: `c${c.id}`, name: c.name || displayIdentity(c.identities[0]?.value) || 'Unnamed', roles: c.roles || [],
      phone: c.identities.find((i) => i.kind === 'phone' && !i.opted_out)?.value || c.identities.find((i) => i.kind === 'phone')?.value || null,
      email: c.identities.find((i) => i.kind === 'email')?.value || null,
      contactId: c.id, customerId: c.l27_customer_id || undefined, teamId: c.l27_team_id || undefined, from: 'inbox',
    }));
    const knownCustomers = new Set(mine.map((p) => p.customerId).filter(Boolean));
    const knownCleaners = new Set(mine.map((p) => p.teamId).filter(Boolean));
    const theirs: Person[] = [
      ...(customers.data || []).filter((c) => !knownCustomers.has(c.id)).map((c): Person => ({ key: `u${c.id}`, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || c.email || `Customer ${c.id}`, roles: ['customer'], phone: c.phone || null, email: c.email || null, customerId: c.id, from: 'bookings' })),
      ...(cleaners.data || []).filter((t) => !knownCleaners.has(t.id)).map((t): Person => ({ key: `t${t.id}`, name: t.title || [t.first_name, t.last_name].filter(Boolean).join(' ') || `Cleaner ${t.id}`, roles: ['cleaner'], phone: t.phone || null, email: t.email || null, teamId: t.id, from: 'bookings' })),
    ];
    return { mine, theirs };
  }, [here.data, customers.data, cleaners.data]);
  const loading = on && (here.isLoading || customers.isLoading || cleaners.isLoading);
  const nothing = on && !loading && !people.mine.length && !people.theirs.length;
  const typed: { phone?: string; email?: string } = looksLikeEmail(q) ? { email: q.trim() } : looksLikePhone(q) ? { phone: q.trim() } : {};
  const exact = !!(typed.phone || typed.email);

  const open = (id: number) => { onClose(); navigate(`/inbox/${id}`); };
  const start = async (p: Person, channel: Ch, to?: string) => {
    const have = channel === 'sms' ? p.phone : p.email;
    if (!have && !to) { setMissing({ person: p, channel, value: '' }); setError(null); return; }
    setBusy(`${p.key}:${channel}`);
    setError(null);
    try {
      // A customer or cleaner from Launch27 becomes a contact here on first use.
      const contactId = p.contactId ?? (await inbox.fromL27(p.customerId ? { customer_id: p.customerId } : { team_id: p.teamId })).id;
      open((await inbox.start({ contact_id: contactId, channel, to: to || undefined })).id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const Row = ({ p }: { p: Person }) => {
    const asking = missing?.person.key === p.key ? missing : null;
    return (
      <div className="nc-row">
        <Avatar name={p.name} size={36} />
        <div className="nc-who">
          <div className="nc-name">
            <span className="nc-name-text">{p.name}</span>
            {p.roles.map((r) => <span key={r} className={`chip role-${r}`}>{ROLE_LABEL[r]}</span>)}
          </div>
          <div className="muted small nc-ids">{[p.phone && displayIdentity(p.phone), p.email].filter(Boolean).join(' · ') || 'No number or email on file'}</div>
          {p.hint && <div className="small nc-when">{p.hint}</div>}
          {asking && (
            <form className="nc-missing" onSubmit={(e) => { e.preventDefault(); if (asking.value.trim()) start(p, asking.channel, asking.value.trim()); }}>
              <input autoFocus type={asking.channel === 'email' ? 'email' : 'tel'} placeholder={asking.channel === 'email' ? 'Their email address' : 'Their mobile number'} aria-label={asking.channel === 'email' ? 'Email address' : 'Mobile number'} value={asking.value} onChange={(e) => setMissing({ ...asking, value: e.target.value })} />
              <button type="submit" disabled={!asking.value.trim() || !!busy}>{asking.channel === 'email' ? 'Email' : 'Text'}</button>
              <button type="button" className="link small" onClick={() => setMissing(null)}>Cancel</button>
            </form>
          )}
        </div>
        {!asking && (
          <div className="nc-actions">
            <button type="button" className={!p.phone ? 'nc-btn none' : p.prefer === 'sms' ? 'nc-btn usual' : 'nc-btn'} disabled={!!busy} title={p.phone ? `Text ${displayIdentity(p.phone)}` : 'No mobile number on file: add one'} onClick={() => start(p, 'sms')}>
              <Icon name="sms" size={15} /> {busy === `${p.key}:sms` ? 'Opening…' : p.phone ? 'Text' : 'Text…'}
            </button>
            <button type="button" className={!p.email || emailLocked ? 'nc-btn none' : p.prefer === 'email' ? 'nc-btn usual' : 'nc-btn'} disabled={!!busy || emailLocked} title={emailLocked ? "Email is read-only: emails can't be sent from this platform" : p.email ? `Email ${p.email}` : 'No email on file: add one'} onClick={() => start(p, 'email')}>
              <Icon name="email" size={15} /> {busy === `${p.key}:email` ? 'Opening…' : p.email ? 'Email' : 'Email…'}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="modal-backdrop top" onClick={onClose}>
      <div className="card nc" role="dialog" aria-modal="true" aria-label="New conversation" onClick={(e) => e.stopPropagation()}>
        <div className="nc-head">
          <h2>New conversation</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        {!adding ? (
          <>
            <div className="nc-search">
              <Icon name="search" size={18} />
              <input ref={input} type="search" placeholder="Name, phone number or email" aria-label="Who do you want to reach?" value={q} onChange={(e) => { setQ(e.target.value); setMissing(null); setError(null); }} />
            </div>
            {error && <div className="error small nc-error">{error}</div>}
            <div className="nc-results">
              {!on && suggestions.recent.length > 0 && <div className="nc-label">Recent</div>}
              {!on && suggestions.recent.map((p) => <Row key={p.key} p={p} />)}
              {!on && suggestions.frequent.length > 0 && <div className="nc-label">Often contacted</div>}
              {!on && suggestions.frequent.map((p) => <Row key={p.key} p={p} />)}
              {!on && !suggested.isLoading && !suggestions.recent.length && !suggestions.frequent.length && <p className="muted nc-hint">Type a name, a phone number or an email address. Pick <b>Text</b>{emailLocked ? '' : <> or <b>Email</b></>} beside the person and start writing.</p>}
              {!on && (suggestions.recent.length > 0 || suggestions.frequent.length > 0) && <p className="muted small nc-hint">Not here? Type a name, number or email above.</p>}
              {loading && <p className="muted small nc-hint">Searching…</p>}
              {people.mine.length > 0 && <div className="nc-label">Already in the inbox</div>}
              {people.mine.map((p) => <Row key={p.key} p={p} />)}
              {people.theirs.length > 0 && <div className="nc-label">From Launch27</div>}
              {people.theirs.map((p) => <Row key={p.key} p={p} />)}
              {nothing && <p className="muted nc-hint">Nobody matches “{term}”.</p>}
            </div>
            <button type="button" className="nc-new" onClick={() => { setAdding(true); setError(null); }}>
              <span className="nc-plus" aria-hidden="true">+</span>
              <span>
                <b>{exact && nothing ? `Add ${typed.email || displayIdentity(typed.phone)} as a new contact` : 'Someone new? Add a contact'}</b>
                <span className="muted small">{emailLocked ? 'Name and number, then text them' : 'Name, number or email, then text or email them'}</span>
              </span>
            </button>
          </>
        ) : (
          <NewContact start={typed} startName={!exact && nothing ? q.trim() : ''} emailLocked={emailLocked} onBack={() => setAdding(false)} onStarted={open} />
        )}
      </div>
    </div>
  );
}

function NewContact({ start, startName, emailLocked, onBack, onStarted }: { start: { phone?: string; email?: string }; startName: string; emailLocked: boolean; onBack: () => void; onStarted: (conversationId: number) => void }) {
  const [name, setName] = useState(startName);
  const [phone, setPhone] = useState(start.phone || '');
  const [email, setEmail] = useState(start.email || '');
  const [kind, setKind] = useState(0);
  const [busy, setBusy] = useState<Ch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const phoneOk = !phone.trim() || looksLikePhone(phone);
  const emailOk = !email.trim() || looksLikeEmail(email);
  const go = async (channel: Ch) => {
    setBusy(channel);
    setError(null);
    try {
      const contact = await inbox.createContact({ name: name.trim(), roles: KINDS[kind].roles, phone: phone.trim() || undefined, email: email.trim() || undefined });
      onStarted((await inbox.start({ contact_id: contact.id, channel })).id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };
  return (
    <form className="nc-form" onSubmit={(e) => e.preventDefault()}>
      <button type="button" className="link small nc-back" onClick={onBack}>← Back to search</button>
      <label>Name<input ref={first} value={name} placeholder="Who is this?" onChange={(e) => setName(e.target.value)} /></label>
      <div className="nc-two">
        <label>Mobile number<input type="tel" inputMode="tel" value={phone} placeholder="613 555 0100" onChange={(e) => setPhone(e.target.value)} />{!phoneOk && <span className="error small">10 digits, with area code</span>}</label>
        <label>Email<input type="email" inputMode="email" value={email} placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} />{!emailOk && <span className="error small">That does not look like an email address</span>}</label>
      </div>
      <div className="nc-two">
        <label>They are a<select value={kind} onChange={(e) => setKind(Number(e.target.value))}>{KINDS.map((k, i) => <option key={k.label} value={i}>{k.label}</option>)}</select></label>
      </div>
      {error && <div className="error small">{error}</div>}
      <div className="nc-form-actions">
        <button type="button" disabled={!!busy || !phone.trim() || !phoneOk} title={!phone.trim() ? 'Add a mobile number to text them' : undefined} onClick={() => go('sms')}><Icon name="sms" size={15} /> {busy === 'sms' ? 'Opening…' : 'Save and text'}</button>
        <button type="button" disabled={!!busy || !email.trim() || !emailOk || emailLocked} title={emailLocked ? "Email is read-only: emails can't be sent from this platform" : !email.trim() ? 'Add an email address to email them' : undefined} onClick={() => go('email')}><Icon name="email" size={15} /> {busy === 'email' ? 'Opening…' : 'Save and email'}</button>
      </div>
      <p className="muted small">If this number or email is already on someone here, that person is used instead of making a second record.</p>
    </form>
  );
}
