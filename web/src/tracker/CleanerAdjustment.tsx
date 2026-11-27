// Cleaner Adjustment: Kustomer's sidebar card. Submit adds one row to the pay adjustments
// Google Sheet (the record of truth); Open Sheet opens it. Customer name and address and
// "Submitted By" are filled in from the conversation, the customer and who is signed in.
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import type { Customer } from '../types';
import type { Contact } from '../inbox/api';
import { useInboxMe } from '../inbox/util';
import { adjustments, type AdjustmentForm } from './api';

const EMPTY: AdjustmentForm = { cleaner_name: '', amount: '', category: '', reason: '', customer_name: '', net_impact: '', submitted_by: '', approved_by: '', customer_address: '', service_date: '' };

export function CleanerAdjustmentCard({ contact, conversationId, cleanerName }: { contact?: Contact | null; conversationId?: number; cleanerName?: string | null }) {
  const me = useInboxMe();
  const meta = useQuery({ queryKey: ['adjustments', 'meta'], queryFn: adjustments.meta, staleTime: 5 * 60_000 });
  const isCleaner = !!contact?.roles.includes('cleaner') && !contact?.l27_customer_id;
  const cid = isCleaner ? null : contact?.l27_customer_id || null;
  // Same query the customer panel uses, so this is normally already loaded.
  const customer = useQuery({ queryKey: ['customer', String(cid)], queryFn: () => l27<Customer>(`/v1/staff/customers/${cid}`), enabled: !!cid, staleTime: 5 * 60_000 });
  const [f, setF] = useState<AdjustmentForm>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof AdjustmentForm, boolean>>>({});
  const [sent, setSent] = useState<string | null>(null);

  // Prefill what we know, without overwriting anything already typed.
  const c = customer.data;
  const address = c ? [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ') : '';
  const known: Partial<AdjustmentForm> = {
    customer_name: isCleaner ? '' : contact?.name || (c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : ''),
    customer_address: address,
    cleaner_name: isCleaner ? contact?.name || '' : cleanerName || '',
    submitted_by: me.data?.name || me.data?.email || '',
  };
  const knownKey = JSON.stringify(known);
  useEffect(() => {
    setF((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(JSON.parse(knownKey) as Partial<AdjustmentForm>)) if (!touched[k as keyof AdjustmentForm] && v) next[k as keyof AdjustmentForm] = v;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownKey]);

  const set = (k: keyof AdjustmentForm) => (e: { target: { value: string } }) => {
    setTouched((t) => ({ ...t, [k]: true }));
    setF((prev) => ({ ...prev, [k]: e.target.value }));
    setSent(null);
  };
  const submit = useMutation({
    mutationFn: () => adjustments.submit({ ...f, conversation_id: conversationId, contact_id: contact?.id }),
    onSuccess: (r) => {
      setSent(r.outcome === 'sent' ? `Added to the sheet (row ${r.row}).` : r.note || 'Recorded.');
      // Ready for the next one for the same visit: keep who and where, clear the adjustment itself.
      setF((prev) => ({ ...prev, amount: '', category: '', reason: '', net_impact: '', approved_by: '' }));
    },
  });
  const m = meta.data;
  const ready = f.cleaner_name.trim() && f.amount.trim() && f.category && f.net_impact && f.service_date;
  return (
    <details className="ct-adjust">
      <summary>Cleaner Adjustment</summary>
      <div className="ct-adjust-body">
        <label>Cleaner Name<input value={f.cleaner_name} onChange={set('cleaner_name')} /></label>
        <label>Adjustment Amount<input inputMode="decimal" value={f.amount} placeholder="-30 for a deduction" onChange={set('amount')} /></label>
        <label>Category
          <select value={f.category} onChange={set('category')}>
            <option value="">Select…</option>
            {m?.categories.map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <label>Reason for Adjustment
          <textarea rows={3} maxLength={m?.reason_max || 1024} value={f.reason} onChange={set('reason')} />
          <span className="muted small">{f.reason.length} / {m?.reason_max || 1024}</span>
        </label>
        <label>Customer Name<input value={f.customer_name} onChange={set('customer_name')} /></label>
        <label>Net Impact
          <select value={f.net_impact} onChange={set('net_impact')}>
            <option value="">Select…</option>
            {m?.net_impacts.map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <label>Submitted By<input value={f.submitted_by} onChange={set('submitted_by')} /></label>
        <label>Approved by<input value={f.approved_by} onChange={set('approved_by')} /></label>
        <label>Customer Address<input value={f.customer_address} onChange={set('customer_address')} /></label>
        <label>Service Date<input type="date" value={f.service_date} onChange={set('service_date')} /></label>
        {m?.mode === 'sandbox' && <div className="muted small">Test environment: Submit records the adjustment here and does not touch the real sheet.</div>}
        {m?.mode === 'not_set_up' && <div className="error small">The pay adjustments sheet isn't connected yet.</div>}
        {submit.error && <div className="error small">{(submit.error as Error).message}</div>}
        {sent && <div className="chip ok" role="status">{sent}</div>}
        <div className="actions">
          <button disabled={!ready || submit.isPending || m?.mode === 'not_set_up'} onClick={() => submit.mutate()}>{submit.isPending ? 'Submitting…' : 'Submit'}</button>
          {m?.sheet_url ? <a className="button secondary" href={m.sheet_url} target="_blank" rel="noreferrer">Open Sheet</a> : <button className="secondary" disabled title="No sheet in this environment">Open Sheet</button>}
        </div>
      </div>
    </details>
  );
}
