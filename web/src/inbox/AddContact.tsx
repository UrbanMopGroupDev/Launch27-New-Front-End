import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { contactsInConflict, inbox, type ContactSummary, type Role } from './api';
import { displayIdentity, looksLikeEmail, looksLikePhone } from './util';

// "Add contact" (Contacts page and a contact's page). One contact per person: an email or phone
// number that is already on a contact opens that contact (anything new is added to it) instead
// of making a second one.

const TYPES: { value: string; label: string; roles: Role[]; lead: boolean }[] = [
  // A lead is not a customer until they book: no Customer role until linked to Launch27.
  { value: 'lead', label: 'Lead (wants a quote or booking)', roles: [], lead: true },
  { value: 'customer', label: 'Customer (link them to Launch27 next)', roles: ['customer'], lead: false },
  { value: 'applicant', label: 'Job applicant', roles: ['applicant'], lead: false },
  { value: 'other', label: 'Vendor, partner or other', roles: [], lead: false },
];

export function AddContact({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [type, setType] = useState(TYPES[0].value);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ContactSummary[]>([]);
  const phoneOk = !phone.trim() || looksLikePhone(phone);
  const emailOk = !email.trim() || looksLikeEmail(email);
  const canSave = !busy && !!(name.trim() || phone.trim() || email.trim()) && phoneOk && emailOk;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setConflict([]);
    try {
      const t = TYPES.find((x) => x.value === type)!;
      const c = await inbox.createContact({
        name: name.trim(),
        roles: t.roles,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        notes: notes.trim() || undefined,
        ...(t.lead ? { lead_stage: 'New', lead_source: 'Added by hand' } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
      onClose();
      const notice = c.existing ? `${c.name || 'This contact'} already had that ${phone.trim() && email.trim() ? 'phone number or email' : phone.trim() ? 'phone number' : 'email'}, so no second contact was made. Anything new you typed was added here.` : null;
      navigate(`/contacts/${c.id}`, { state: notice ? { notice } : undefined });
    } catch (err) {
      setError((err as Error).message);
      setConflict(contactsInConflict(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <form className="card modal add-contact" role="dialog" aria-label="Add contact" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Add contact</h2>
        <label>
          Name
          <input className="full" value={name} onChange={(e) => setName(e.target.value)} placeholder="First and last name" autoFocus />
        </label>
        <div className="grid-2 tight">
          <label>
            Phone
            <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="613 555 0100" />
            {!phoneOk && <span className="error small">10 digits, with the area code</span>}
          </label>
          <label>
            Email
            <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            {!emailOk && <span className="error small">That does not look like an email address</span>}
          </label>
        </div>
        <label>
          Who are they?
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <label>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Address or postal code, what they need, how they heard of us" />
        </label>
        <p className="muted small">A phone number or email that's already on a contact opens that contact instead of making a second one.</p>
        {error && (
          <div className="error small">
            {error}
            {conflict.map((c) => (
              <div key={c.id}>
                <Link to={`/contacts/${c.id}`} onClick={onClose}>Open {c.name || `contact #${c.id}`}</Link>
              </div>
            ))}
          </div>
        )}
        <div className="actions end">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!canSave}>{busy ? 'Saving…' : 'Save contact'}</button>
        </div>
      </form>
    </div>
  );
}

type Deletable = { name: string | null; l27_customer_id: number | null; l27_team_id: number | null; identities: { value: string }[] };

// The question asked before deleting a contact: what goes, and what stays.
export function deleteContactQuestion(c: Deletable) {
  const who = c.name || displayIdentity(c.identities[0]?.value) || 'this contact';
  return [
    `Delete ${who}?`,
    'Their emails and phone numbers come off the portal. Their conversations stay in the inbox under the number or email they came from, and a number that replied STOP stays blocked. If they get in touch again, they become a new contact.',
    c.l27_customer_id || c.l27_team_id ? `Launch27 is not changed. Opening this ${c.l27_team_id ? 'cleaner' : 'customer'} again makes a fresh contact, and their conversations go back onto it.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const contactLabel = (c: Deletable) => c.name || displayIdentity(c.identities[0]?.value) || 'Contact';
