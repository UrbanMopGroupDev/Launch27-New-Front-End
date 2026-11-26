import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type ContactList, type ContactListRow } from '../inbox/api';
import { AddContact, contactLabel, deleteContactQuestion } from '../inbox/AddContact';
import { ago, displayIdentity } from '../inbox/util';
import { Icon } from '../components/Icon';

// Everyone the portal talks to, one contact per person: an email or phone number is on one
// contact only. "All" includes Launch27 customers and cleaners; the other lists are the people
// who are not (yet) a Launch27 customer or cleaner: leads to follow up, job applicants, vendors
// and others, numbers nobody named, and numbers marked spam or wrong. A lead who books is linked
// to their Launch27 customer from their contact page (or automatically on their next call).
const LISTS: { id: ContactList; label: string; empty: string }[] = [
  { id: 'all', label: 'All', empty: 'No contacts yet. Use Add contact, or they are added when someone texts, emails or calls.' },
  { id: 'leads', label: 'Leads', empty: 'No open leads. Callers saved as "New lead" show here until they are linked to a Launch27 customer.' },
  { id: 'applicants', label: 'Job applicants', empty: 'No job applicants saved.' },
  { id: 'other', label: 'Vendors and others', empty: 'Nobody here.' },
  { id: 'number_only', label: 'Number only', empty: 'Every number has a name.' },
  { id: 'flagged', label: 'Spam and wrong numbers', empty: 'No numbers marked.' },
];

// What kind of contact a row is, for the All list.
function typeOf(r: ContactListRow): { label: string; cls: string } {
  if (r.l27_team_id) return { label: 'Cleaner', cls: 'cleaner' };
  if (r.l27_customer_id) return { label: 'Customer', cls: 'customer' };
  if (r.caller_flag) return { label: r.caller_flag === 'spam' ? 'Spam' : 'Wrong number', cls: 'warn' };
  if (r.roles.includes('applicant')) return { label: 'Job applicant', cls: 'applicant' };
  if (r.lead_stage) return { label: `Lead · ${r.lead_stage}`, cls: 'lead' };
  if (r.roles.includes('customer')) return { label: 'Customer (not linked)', cls: 'customer' };
  return { label: r.name ? 'Other' : 'Number only', cls: '' };
}

export function ContactsPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const list = (LISTS.some((l) => l.id === params.get('list')) ? params.get('list') : 'all') as ContactList;
  const [q, setQ] = useState(params.get('q') || '');
  const [term, setTerm] = useState(q.trim());
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>((location.state as { notice?: string } | null)?.notice || null);
  // Search as they type, a moment after they stop; the search stays in the address bar.
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (term) next.set('q', term);
      else next.delete('q');
      return next;
    }, { replace: true });
  }, [term, setParams]);
  const data = useQuery({ queryKey: ['inbox', 'contact-list', list, term], queryFn: () => inbox.contactList(list, term || undefined), staleTime: 30_000, placeholderData: keepPreviousData });
  const current = LISTS.find((l) => l.id === list)!;
  const pick = (id: ContactList) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('list', id);
      return next;
    });

  const remove = async (r: ContactListRow) => {
    if (!window.confirm(deleteContactQuestion(r))) return;
    setDeleting(r.id);
    setError(null);
    setNotice(null);
    try {
      await inbox.deleteContact(r.id);
      queryClient.removeQueries({ queryKey: ['inbox', 'contact', r.id] });
      await queryClient.invalidateQueries({ queryKey: ['inbox'] });
      setNotice(`${contactLabel(r)} deleted.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  const rows = data.data?.rows || [];
  return (
    <>
      <header className="page-header">
        <div>
          <h1>Contacts</h1>
          <span className="muted small">One contact per person: a phone number or email is on one contact only. Link a lead to their Launch27 customer from their page once they book.</span>
        </div>
        <div className="actions">
          <button type="button" onClick={() => setAdding(true)}>
            <Icon name="user" /> Add contact
          </button>
        </div>
      </header>
      {adding && <AddContact onClose={() => setAdding(false)} />}
      <div className="tabs">
        {LISTS.map((l) => (
          <button key={l.id} className={l.id === list ? 'tab active' : 'tab'} onClick={() => pick(l.id)}>
            {l.label}
            {data.data?.counts[l.id] ? ` (${data.data.counts[l.id]})` : ''}
          </button>
        ))}
      </div>
      <div className="contacts-search">
        <Icon name="search" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, phone number, email or notes" aria-label="Search contacts" />
      </div>
      {notice && <div className="notice small">{notice}</div>}
      {error && <div className="error">{error}</div>}
      {data.isLoading && <div className="muted">Loading…</div>}
      {data.error && <div className="error">{(data.error as Error).message}</div>}
      {data.data && !rows.length && <p className="muted">{term ? `Nobody here matches “${term}”.` : current.empty}</p>}
      {rows.length > 0 && (
        <div className="card no-pad">
          <div className="table-wrap flat">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone or email</th>
                  {list === 'all' && <th>Type</th>}
                  {list === 'leads' && <th>Stage</th>}
                  {list === 'flagged' && <th>Marked as</th>}
                  <th>Notes</th>
                  <th>Last activity</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const t = typeOf(r);
                  return (
                    <tr key={r.id} className="static">
                      <td>
                        <Link to={`/contacts/${r.id}`}>{r.name || 'Unnamed'}</Link>
                      </td>
                      <td>
                        {r.identities.map((i) => (
                          <span key={`${i.kind}:${i.value}`} className="contact-id">
                            {displayIdentity(i.value)}
                            {i.opted_out && <span className="chip neg">STOP</span>}
                          </span>
                        ))}
                        {!r.identities.length && '—'}
                      </td>
                      {list === 'all' && <td><span className={`role-badge ${t.cls}`}>{t.label}</span></td>}
                      {list === 'leads' && <td>{r.lead_stage}{r.lead_source ? <span className="muted small"> · {r.lead_source}</span> : null}</td>}
                      {list === 'flagged' && <td>{r.caller_flag === 'spam' ? 'Spam' : 'Wrong number'}</td>}
                      <td className="muted small">{r.notes ? (r.notes.length > 80 ? `${r.notes.slice(0, 80)}…` : r.notes) : ''}</td>
                      <td className="muted small">{ago(r.last_activity || r.created_at)}</td>
                      <td className="num">
                        <button type="button" className="link small danger-link" disabled={deleting === r.id} onClick={() => remove(r)} aria-label={`Delete ${contactLabel(r)}`}>
                          {deleting === r.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {data.data && rows.length >= data.data.limit && <p className="muted small">Showing the {data.data.limit} most recent. Search to find anyone else.</p>}
    </>
  );
}
