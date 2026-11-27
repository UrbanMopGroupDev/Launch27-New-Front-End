import { CleanerAdjustmentCard } from '../tracker/CleanerAdjustment';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contactsInConflict, inbox, type Channel, type Contact, type ContactSummary, type Identity, type Role } from '../inbox/api';
import { Customer360, Story } from '../inbox/Customer360';
import { Cleaner360 } from '../inbox/Cleaner360';
import { CleanerProfile } from '../inbox/CleanerProfile';
import { ApiError } from '../api';
import { AddContact, contactLabel, deleteContactQuestion } from '../inbox/AddContact';
import { CHANNEL_ICON, ROLE_LABEL, ago, displayIdentity, useInboxMe, useMeta } from '../inbox/util';

// ---------- Contact profile (full-page 360) ----------

export function ContactPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const contact = useQuery({ queryKey: ['inbox', 'contact', Number(id)], queryFn: () => inbox.contact(Number(id)) });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const notice = (location.state as { notice?: string } | null)?.notice || null;
  // A contact merged into another: open that one.
  const mergedInto = contact.error instanceof ApiError ? (contact.error.fields as { merged_into?: number } | undefined)?.merged_into : undefined;
  useEffect(() => {
    if (mergedInto) navigate(`/contacts/${mergedInto}`, { replace: true, state: { notice: 'That contact was merged into this one.' } });
  }, [mergedInto, navigate]);
  if (contact.isLoading) return <div className="muted">Loading…</div>;
  if (contact.error) return <div className="error">{(contact.error as Error).message}</div>;
  const c = contact.data!;
  const toggleRole = async (role: Role) => {
    const roles = c.roles.includes(role) ? c.roles.filter((r) => r !== role) : [...c.roles, role];
    await inbox.updateContact(c.id, { roles });
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
  };
  const start = async (channel: 'sms' | 'email') => {
    setError(null);
    try {
      const conv = await inbox.start({ contact_id: c.id, channel });
      navigate(`/inbox/${conv.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // Deleting keeps their conversations (under the number or email) and any STOP on the number.
  const remove = async () => {
    if (!window.confirm(deleteContactQuestion(c))) return;
    setDeleting(true);
    setError(null);
    try {
      await inbox.deleteContact(c.id);
      queryClient.removeQueries({ queryKey: ['inbox', 'contact', c.id] });
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
      navigate('/contacts', { replace: true, state: { notice: `${contactLabel(c)} deleted.` } });
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };
  const roleBoxes = (
    <div className="small spaced">
      Roles:{' '}
      {(['customer', 'cleaner', 'applicant'] as Role[]).map((r) => (
        <label key={r} className="check inline"><input type="checkbox" checked={c.roles.includes(r)} onChange={() => toggleRole(r)} /> {ROLE_LABEL[r]}</label>
      ))}
    </div>
  );
  const deleteButton = (
    <button type="button" className="link small danger-link" disabled={deleting} onClick={remove}>
      {deleting ? 'Deleting…' : 'Delete contact'}
    </button>
  );

  // Someone not in Launch27 (no customer, not a cleaner): this page is where their Story lives.
  const storyHere = !c.l27_customer_id && !c.l27_team_id && !c.roles.includes('cleaner');

  // Cleaners get their own profile; contact details sit behind "Edit contact".
  if (c.roles.includes('cleaner') && c.l27_team_id) {
    return (
      <>
        <div className="muted small cp-crumb"><Link to="/teams">Teams</Link> / {c.name}</div>
        {notice && <div className="notice small">{notice}</div>}
        {error && <div className="error">{error}</div>}
        <CleanerProfile
          tid={c.l27_team_id}
          contact={c}
          onText={() => start('sms')}
          onEmail={() => start('email')}
          editContact={
            <div className="cp-edit-inner">
              <DetailsEditor key={`${c.id}:${c.name}:${c.notes}`} contact={c} />
              <IdentityEditor contact={c} />
              {roleBoxes}
              <div className="actions spaced">{deleteButton}</div>
            </div>
          }
        />
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <div className="muted small"><Link to="/contacts">Contacts</Link> /</div>
          <h1>
            {c.name || 'Unnamed contact'} {c.roles.map((r) => <span key={r} className={`role-badge ${r}`}>{ROLE_LABEL[r]}</span>)}
            {c.lead_stage && !c.l27_customer_id && !c.roles.includes('applicant') && <span className="role-badge lead">Lead · {c.lead_stage}</span>}
            {c.caller_flag && <span className="role-badge warn">{c.caller_flag === 'spam' ? 'Spam' : 'Wrong number'}</span>}
          </h1>
        </div>
        <div className="actions">
          <button onClick={() => start('sms')}>New text</button>
          <button className="secondary" onClick={() => start('email')}>New email</button>
          <DialButton contact={c} />
          <button type="button" className="secondary" onClick={() => setAdding(true)}>Add contact</button>
        </div>
      </header>
      {adding && <AddContact onClose={() => setAdding(false)} />}
      {notice && <div className="notice small">{notice}</div>}
      {error && <div className="error">{error}</div>}
      {c.caller_flag && (
        <div className="notice small">
          Calls from this number show "{c.caller_flag === 'spam' ? 'Likely spam' : 'Wrong number before'}" on the call card.{' '}
          <button className="link small" onClick={() => inbox.updateContact(c.id, { caller_flag: null }).then(() => queryClient.invalidateQueries({ queryKey: ['inbox'] }))}>Remove the label</button>
        </div>
      )}
      <div className="grid-2 contact-grid">
        <section className="card">
          <h2>Details</h2>
          <DetailsEditor key={`${c.id}:${c.name}:${c.notes}`} contact={c} />
          <h3>Phone numbers and emails</h3>
          <IdentityEditor contact={c} />
          {roleBoxes}
          {c.roles.includes('customer') || !c.roles.length ? <LeadFields contact={c} /> : null}
          {!storyHere && (
            <>
              <h3>Conversations</h3>
              <div className="mini-list">
                {c.conversations?.map((x) => (
                  <Link key={x.id} to={`/inbox/${x.id}`} className="mini-row link-row">
                    <span>{CHANNEL_ICON[x.channel]}</span>
                    <span className="clip">{x.subject || x.last_preview}</span>
                    <span className="muted small">{x.disposition?.reason || x.status} · {ago(x.last_message_at)}</span>
                  </Link>
                ))}
                {!c.conversations?.length && <div className="muted small">None yet.</div>}
              </div>
            </>
          )}
          <div className="actions spaced">{deleteButton}</div>
        </section>
        <section className="card no-pad">
          {c.roles.includes('cleaner') ? <Cleaner360 contact={c} /> : <Customer360 contact={c} hideHistory={storyHere} />}
          <CleanerAdjustmentCard contact={c} />
        </section>
      </div>
      {/* Not in Launch27 (e.g. a profile the Kustomer import made): their Story is every conversation. */}
      {storyHere && <Story contactId={c.id} conversationsOnly />}
    </>
  );
}

// Name and notes. Saved with the Save button; the call card treats unsaved changes as work in
// progress (data-unsaved), so answering a call doesn't navigate away from them.
function DetailsEditor({ contact }: { contact: Contact }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(contact.name || '');
  const [notes, setNotes] = useState(contact.notes || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== (contact.name || '').trim() || notes.trim() !== (contact.notes || '').trim();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await inbox.updateContact(contact.id, { name: name.trim() || null, notes: notes.trim() || null });
      await queryClient.invalidateQueries({ queryKey: ['inbox'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setName(contact.name || '');
    setNotes(contact.notes || '');
    setError(null);
  };
  return (
    <div className="contact-details" data-unsaved={dirty ? 'true' : undefined}>
      <label>
        Name
        <input className="full" value={name} onChange={(e) => setName(e.target.value)} placeholder="First and last name" />
      </label>
      <label>
        Notes
        <textarea className="full" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Address or postal code, what they need, anything the team should know" />
      </label>
      {dirty && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save details'}</button>
          <button type="button" className="secondary" disabled={busy} onClick={reset}>Cancel</button>
        </div>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

// Emails and phone numbers: add, change, label, remove, and the opt-out from texts. One that is
// already on another contact can't be added here; the two contacts can be merged instead.
function IdentityEditor({ contact }: { contact: Contact }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'phone' | 'email'>('phone');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ value: '', label: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ContactSummary | null>(null);
  const who = contact.name || 'this contact';
  const attempt = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      await fn();
      after?.();
      await queryClient.invalidateQueries({ queryKey: ['inbox'] });
    } catch (err) {
      setError((err as Error).message);
      setConflict(contactsInConflict(err).find((x) => x.id !== contact.id) || null);
    } finally {
      setBusy(false);
    }
  };
  const add = () => attempt(() => inbox.addIdentity(contact.id, kind, value.trim(), label.trim() || undefined), () => { setValue(''); setLabel(''); });
  const edit = (i: Identity) => {
    setEditing(i.id);
    setDraft({ value: i.kind === 'phone' ? displayIdentity(i.value) : i.value, label: i.label || '' });
    setError(null);
    setConflict(null);
  };
  const saveEdit = (i: Identity) => attempt(() => inbox.updateIdentity(i.id, { value: draft.value.trim(), label: draft.label.trim() || null }), () => setEditing(null));
  const remove = (i: Identity) => {
    const notes = [
      `Remove ${displayIdentity(i.value)} from ${who}?`,
      i.opted_out ? 'It replied STOP, so texts to it stay blocked.' : '',
      contact.l27_customer_id || contact.l27_team_id ? 'Launch27 is not changed, and the portal will not add it back from Launch27.' : '',
    ];
    if (window.confirm(notes.filter(Boolean).join('\n\n'))) attempt(() => inbox.removeIdentity(i.id), () => setEditing(null));
  };
  const merge = (other: ContactSummary) => {
    const them = other.name || `contact #${other.id}`;
    if (!window.confirm(`Merge ${them} into ${who}?\n\nTheir phone numbers, emails and conversations move here, ${them} is deleted, and ${who} keeps its own details (taking theirs only where it has none).`)) return;
    attempt(() => inbox.mergeContact(contact.id, other.id), () => {
      setEditing(null);
      setValue('');
      setLabel('');
    });
  };
  return (
    <div className="identity-editor">
      {contact.identities.map((i) =>
        editing === i.id ? (
          <div key={i.id} className="row-line id-edit">
            <input aria-label={i.kind === 'phone' ? 'Phone number' : 'Email'} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} autoFocus />
            <input aria-label="Label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Label (cell, work…)" />
            <span className="actions">
              <button type="button" disabled={busy || !draft.value.trim()} onClick={() => saveEdit(i)}>Save</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
            </span>
          </div>
        ) : (
          <div key={i.id} className="row-line">
            <span>{i.kind === 'phone' ? '☎' : '✉'} {displayIdentity(i.value)} {i.label && <span className="muted small">({i.label})</span>}</span>
            <span className="actions">
              {i.kind === 'phone' && (
                <label className="check small" title={i.opted_out && i.opted_out_by !== 'agent' ? 'They texted STOP. Only a START text from them turns texts back on.' : undefined}>
                  <input type="checkbox" checked={i.opted_out} disabled={busy || (i.opted_out && i.opted_out_by !== 'agent')} onChange={(e) => attempt(() => inbox.setOptOut(i.id, e.target.checked))} /> {i.opted_out && i.opted_out_by !== 'agent' ? 'Texted STOP' : 'Opted out of texts'}
                </label>
              )}
              <button type="button" className="link small" disabled={busy} onClick={() => edit(i)}>Edit</button>
              <button type="button" className="link small danger-link" disabled={busy} onClick={() => remove(i)}>Remove</button>
            </span>
          </div>
        ),
      )}
      {!contact.identities.length && <div className="muted small">No phone number or email yet.</div>}
      <form className="actions spaced" onSubmit={(e) => { e.preventDefault(); if (value.trim()) add(); }}>
        <select aria-label="Add a" value={kind} onChange={(e) => setKind(e.target.value as 'phone' | 'email')}><option value="phone">Phone</option><option value="email">Email</option></select>
        <input aria-label={kind === 'phone' ? 'New phone number' : 'New email'} value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'phone' ? '613-555-0100' : 'name@example.com'} />
        <input aria-label="Label for it" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
        <button type="submit" className="secondary" disabled={busy || !value.trim()}>Add</button>
      </form>
      {error && (
        <div className="error small">
          {error}
          {conflict && (
            <div className="actions">
              <Link to={`/contacts/${conflict.id}`}>Open {conflict.name || 'that contact'}</Link>
              <button type="button" className="link small" disabled={busy} onClick={() => merge(conflict)}>Merge {conflict.name || 'them'} into {who}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const LEAD_STAGES = ['', 'New', 'Attempt #1', 'Attempt #2', 'Attempt #3', 'Contacted Highly Interested', 'Contacted Undecided', 'Booked', 'Not Interested-Price', 'Not Interested-Timing', 'Not Interested-Other', 'Non-Region'];

function LeadFields({ contact }: { contact: Contact }) {
  const queryClient = useQueryClient();
  const save = (patch: Partial<Contact>) => inbox.updateContact(contact.id, patch).then(() => queryClient.invalidateQueries({ queryKey: ['inbox'] }));
  return (
    <div className="grid-3 spaced">
      <label>Lead stage<select value={contact.lead_stage || ''} onChange={(e) => save({ lead_stage: e.target.value || null })}>{LEAD_STAGES.map((s) => <option key={s} value={s}>{s || '—'}</option>)}</select></label>
      <label>Lead source<input defaultValue={contact.lead_source || ''} onBlur={(e) => e.target.value !== (contact.lead_source || '') && save({ lead_source: e.target.value || null })} /></label>
      <label>Prefers<select value={contact.communication_preference || ''} onChange={(e) => save({ communication_preference: e.target.value || null })}><option value="">—</option><option>Text</option><option>Email</option><option>Call</option></select></label>
    </div>
  );
}

// Click-to-dial through the RingCentral widget (when it's configured).
export function DialButton({ contact }: { contact: Contact }) {
  const meta = useMeta();
  const phone = contact.identities.find((i) => i.kind === 'phone')?.value;
  if (!phone || !meta.data?.ringcentral || meta.data.ringcentral.record === false) return null;
  return <button className="secondary" onClick={() => window.dispatchEvent(new CustomEvent('workspace:dial', { detail: phone }))}>☎ Call</button>;
}

// Opens (or creates) the workspace contact for a Launch27 customer or cleaner.
export function OpenL27Contact({ customerId, teamId, label = 'Support profile' }: { customerId?: number; teamId?: number; label?: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const c = await inbox.fromL27(customerId ? { customer_id: customerId } : { team_id: teamId });
            navigate(`/contacts/${c.id}`);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Opening…' : label}
      </button>
      {error && <span className="error small">{error}</span>}
    </>
  );
}

// ---------- Supervisor ----------

export function SupervisorPage() {
  const data = useQuery({ queryKey: ['inbox', 'supervisor'], queryFn: inbox.supervisor, refetchInterval: 10_000 });
  const me = useInboxMe();
  const queryClient = useQueryClient();
  const setAgentStatus = async (userId: number, statusId: number) => {
    const r = await inbox.setUserStatus(userId, statusId);
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
    if (r.requeued) alert(`${r.requeued} conversation(s) went back to their queues.`);
  };
  if (data.isLoading) return <div className="muted">Loading…</div>;
  if (data.error) return <div className="error">{(data.error as Error).message}</div>;
  const d = data.data!;
  return (
    <>
      <header className="page-header"><h1>Supervisor</h1><span className="muted small">Live, refreshes every 10 seconds</span></header>
      <div className="tiles">
        <div className="card"><div className="muted small">Open</div><div className="tile-value">{d.queues.reduce((s, q) => s + q.open, 0)}</div></div>
        <div className="card"><div className="muted small">Unassigned</div><div className="tile-value">{d.queues.reduce((s, q) => s + q.unassigned, 0)}</div></div>
        <div className="card"><div className="muted small">Past reply target</div><div className="tile-value neg">{d.queues.reduce((s, q) => s + q.breached, 0)}</div></div>
        <div className="card"><div className="muted small">Median first reply (7 days)</div><div className="tile-value">{d.first_response.median_minutes === null ? '—' : `${Math.round(d.first_response.median_minutes)} min`}</div><div className="muted small">{d.first_response.n} conversations</div></div>
      </div>
      <div className="grid-2">
        <section className="card no-pad">
          <div className="table-wrap flat">
            <table>
              <thead><tr><th>Queue</th><th className="num">Open</th><th className="num">Unassigned</th><th className="num">Late</th><th>Oldest waiting</th><th className="num">Done today</th></tr></thead>
              <tbody>
                {d.queues.map((q) => (
                  <tr key={q.id} onClick={() => (window.location.href = `/inbox?view=queue:${q.id}`)}>
                    <td>{q.name}</td><td className="num">{q.open}</td><td className="num">{q.unassigned || ''}</td><td className={q.breached ? 'num neg' : 'num'}>{q.breached || ''}</td><td>{q.oldest_waiting ? `${ago(q.oldest_waiting)} ago` : ''}</td><td className="num">{q.done_today}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card no-pad">
          <div className="table-wrap flat">
            <table>
              <thead><tr><th>Agent</th><th>Status</th><th className="num">Away today</th><th className="num">Open</th><th className="num">Late</th><th className="num">Done today</th></tr></thead>
              <tbody>
                {d.agents.map((a) => {
                  const mins = a.status_since ? Math.floor((Date.now() - new Date(a.status_since).getTime()) / 60_000) : null;
                  const over = !!a.status_max && mins !== null && mins > a.status_max;
                  return (
                  <tr key={a.id} className="static">
                    <td>{a.name || a.email} <span className="muted small">{a.role !== 'agent' ? a.role : ''}</span></td>
                    <td>
                      <span className="status-cell">
                        <span className="status-dot" style={{ background: a.status_color || '#9aa3ad' }} />
                        <select aria-label={`Status for ${a.name || a.email}`} value={a.status_id ?? ''} onChange={(e) => setAgentStatus(a.id, Number(e.target.value))}>
                          {!a.status_id && <option value="">—</option>}
                          {me.data?.statuses?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                        {mins !== null && <span className={over ? 'chip neg' : 'muted small'}>{mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`}{over ? ` (limit ${a.status_max}m)` : ''}</span>}
                      </span>
                    </td>
                    <td className="num">{a.away_minutes_today ? `${a.away_minutes_today}m` : ''}</td>
                    <td className="num">{a.open}</td><td className={a.breached ? 'num neg' : 'num'}>{a.breached || ''}</td><td className="num">{a.done_today}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}

// ---------- Simulator ----------

const SCENARIOS: { label: string; msg: { channel: Channel; from: string; to: string; subject?: string; body: string; from_name?: string } }[] = [
  { label: 'Customer: is my cleaner coming?', msg: { channel: 'sms', from: '613-555-0142', to: '+16136919880', body: 'Hi, my cleaning was supposed to start at 9. Is someone still coming?' } },
  { label: 'Cleaner: running late', msg: { channel: 'sms', from: '613-555-0177', to: '+16136919880', body: 'Stuck in traffic on the 417, about 20 min late to my 10am', from_name: 'Test Cleaner' } },
  { label: 'Quote request email', msg: { channel: 'email', from: 'new.lead@example.com', to: 'info@urbanmop.ca', subject: 'Jordan submitted an inquiry', body: '3 bed 2 bath in Kanata, looking for biweekly cleaning. What would it cost?', from_name: 'Jordan Lee' } },
  { label: 'Billing question', msg: { channel: 'email', from: 'pat@example.com', to: 'billing@urbanmop.ca', subject: 'Charged twice?', body: 'I see two charges of $186.45 this week. Can you check?', from_name: 'Pat Morgan' } },
  { label: 'Unhappy rating reply', msg: { channel: 'email', from: 'casey@example.com', to: 'info@urbanmop.ca', subject: 'Re: Ratings email', body: "It wasn't good. The bathrooms were skipped.", from_name: 'Casey Ng' } },
  { label: 'Applicant text', msg: { channel: 'sms', from: '613-555-0188', to: '+16136918368', body: 'Hi, I applied on Indeed for the cleaner job. When is my interview?' } },
  { label: 'Escalation', msg: { channel: 'email', from: 'vip@example.com', to: 'management@urbanmop.ca', subject: 'Very disappointed', body: 'I have been a client for 3 years and this is the third missed clean.' } },
  { label: 'System notice (auto-done)', msg: { channel: 'email', from: 'notifications@kustomerapp.com', to: 'info@urbanmop.ca', subject: "You've been assigned to a conversation", body: 'notification' } },
  { label: 'Customer texts STOP', msg: { channel: 'sms', from: '613-555-0142', to: '+16136919880', body: 'STOP' } },
];

export function SimulatorPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [m, setM] = useState(SCENARIOS[0].msg);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dry, setDry] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => inbox.simulate(m),
    onSuccess: (r) => {
      setError(null);
      setResult(`${r.isNew ? 'New' : r.reopened ? 'Reopened' : 'Added to'} conversation #${r.conversationId}`);
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err) => setError((err as Error).message),
  });
  useEffect(() => {
    const t = setTimeout(() => inbox.testRules(m).then((r) => setDry(r.rule ? `"${r.rule}" → ${String(r.action.queue || (r.action.mark_done ? 'marked done' : '?'))}` : 'No rule → Fallback')).catch(() => setDry(null)), 300);
    return () => clearTimeout(t);
  }, [m]);
  return (
    <>
      <header className="page-header"><h1>Channel simulator</h1><span className="muted small">Phase 1: sends test messages through the same routing, threading and SLA rules real channels will use.</span></header>
      <div className="grid-2">
        <section className="card">
          <h2>Scenarios</h2>
          <div className="assign-list">
            {SCENARIOS.map((s) => <button key={s.label} className="assign-item" onClick={() => setM(s.msg)}>{CHANNEL_ICON[s.msg.channel]} {s.label}</button>)}
          </div>
          <h3>Calls</h3>
          <p className="small muted">Stand-ins for what the RingCentral widget reports when a call ends.</p>
          <div className="actions">
            {(['missed', 'answered'] as const).map((result) => (
              <button
                key={result}
                className="secondary"
                onClick={() =>
                  inbox
                    .logCall({ call_id: `sim-${Date.now()}`, direction: 'inbound', from: m.channel === 'sms' ? m.from : '613-555-0142', to: '+16136919880', result, duration_seconds: result === 'answered' ? 185 : 0, started_at: new Date().toISOString() })
                    .then((r) => {
                      setResult(`Call logged on conversation #${r.conversationId}`);
                      queryClient.invalidateQueries({ queryKey: ['inbox'] });
                    })
                    .catch((err) => setError((err as Error).message))
                }
              >
                ☎ {result === 'missed' ? 'Missed call' : 'Answered call (3 min)'}
              </button>
            ))}
          </div>
          <PhoneSimulator />
        </section>
        <section className="card">
          <h2>Message</h2>
          <div className="grid-3">
            <label>Channel<select value={m.channel} onChange={(e) => setM({ ...m, channel: e.target.value as Channel })}><option value="sms">Text</option><option value="email">Email</option><option value="chat">Chat</option></select></label>
            <label>From<input value={m.from} onChange={(e) => setM({ ...m, from: e.target.value })} /></label>
            <label>To (ours)<input value={m.to} onChange={(e) => setM({ ...m, to: e.target.value })} /></label>
          </div>
          <label>Sender name<input className="full" value={m.from_name || ''} onChange={(e) => setM({ ...m, from_name: e.target.value })} /></label>
          {m.channel === 'email' && <label>Subject<input className="full" value={m.subject || ''} onChange={(e) => setM({ ...m, subject: e.target.value })} /></label>}
          <label>Body<textarea rows={4} className="full" value={m.body} onChange={(e) => setM({ ...m, body: e.target.value })} /></label>
          <div className="small muted">Routing preview: {dry || '…'}</div>
          <div className="actions spaced">
            <button disabled={send.isPending} onClick={() => send.mutate()}>Send inbound</button>
            {result && <span className="ok small">{result}</span>}
            {send.data && <button className="link" onClick={() => navigate(`/inbox/${send.data!.conversationId}?view=all`)}>Open it →</button>}
          </div>
          {error && <div className="error small">{error}</div>}
          <p className="muted small">A sender number that matches a Launch27 cleaner or customer is linked automatically, so try a real cleaner's phone to see the cleaner 360.</p>
        </section>
      </div>
    </>
  );
}

export { InboxSettingsPage } from './SupportSettings';

// /cleaners/:id (Launch27 cleaner id): open that cleaner's profile.
export function CleanerRedirectPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    inbox.fromL27({ team_id: Number(id) }).then((c) => navigate(`/contacts/${c.id}`, { replace: true })).catch((err) => setError((err as Error).message));
  }, [id, navigate]);
  return error ? <div className="error">{error}</div> : <p className="muted">Opening profile…</p>;
}

// Rings the portal's phone with a made-up call, the way the RingCentral widget reports one,
// so the call card and what opens on answer can be tried with test data (dev and QA).
const SIM_CALLERS = [
  { label: 'Customer', phone: '(613) 555-0103' },
  { label: 'Cleaner', phone: '(613) 555-0200' },
  { label: 'Unknown', phone: '(613) 555-9876' },
  { label: 'Hidden', phone: 'Anonymous' },
];
function PhoneSimulator() {
  const meta = useMeta();
  const [phone, setPhone] = useState(SIM_CALLERS[0].phone);
  const [live, setLive] = useState<string | null>(null);
  if (!meta.data?.ringcentral) return null;
  // A private event, not a window message: the real RingCentral widget must never see fake calls.
  const send = (type: string, key: string) => window.dispatchEvent(new CustomEvent('workspace:sim-call', { detail: { type, call: { telephonySessionId: key, direction: 'Inbound', from: { phoneNumber: phone }, to: { phoneNumber: '+16136919880' }, simulated: true } } }));
  const ring = () => {
    const key = `sim-${Date.now()}`;
    setLive(key);
    send('rc-call-ring-notify', key);
  };
  const answer = () => {
    if (!live) return;
    const key = live;
    send('rc-call-start-notify', key);
    setLive(null);
    // The page opens on answer; hang up a minute later on its own.
    setTimeout(() => send('rc-call-end-notify', key), 60_000);
  };
  const hangUp = () => {
    if (!live) return;
    send('rc-call-end-notify', live);
    setLive(null);
  };
  return (
    <>
      <h3>Incoming call</h3>
      <p className="small muted">Rings the phone card with a test caller. Answer opens their page; the test call ends itself a minute later.</p>
      <div className="actions">
        {SIM_CALLERS.map((c) => (
          <button key={c.label} type="button" className={phone === c.phone ? '' : 'secondary'} onClick={() => setPhone(c.phone)}>{c.label}</button>
        ))}
      </div>
      <label>Caller's number<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      <div className="actions">
        {!live ? <button type="button" onClick={ring}>☎ Ring</button> : (
          <>
            <button type="button" onClick={answer}>Answer</button>
            <button type="button" className="secondary" onClick={hangUp}>Hang up (missed)</button>
          </>
        )}
      </div>
    </>
  );
}
