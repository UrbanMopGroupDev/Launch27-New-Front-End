import { useQuery } from '@tanstack/react-query';
import { l27 } from '../api';
import type { Customer, Tag } from '../types';
import { prefChips } from '../lib/customerPrefs';

// A customer's tags and what they say about cleaners, for places that show one booking
// (Dispatch board panel, booking page).
//   GET /v1/staff/customers/:id/tags
//   GET /v1/staff/customers/:id          (profile note)
// `fallback` is whatever tags came with the booking, shown until (or if) the customer's own load.
export function CustomerTags({ customerId, fallback, heading = true }: { customerId?: number; fallback?: Tag[] | null; heading?: boolean }) {
  const id = customerId ? String(customerId) : '';
  const tagsQ = useQuery({ queryKey: ['customer', id, 'tags'], queryFn: () => l27<Tag[] | null>(`/v1/staff/customers/${id}/tags`), enabled: !!id, staleTime: 5 * 60_000, retry: false });
  const customerQ = useQuery({ queryKey: ['customer', id], queryFn: () => l27<Customer>(`/v1/staff/customers/${id}`), enabled: !!id, staleTime: 5 * 60_000, retry: false });
  const tags = (Array.isArray(tagsQ.data) ? tagsQ.data : fallback || []).filter((t) => t?.name);
  const prefs = prefChips(tags);
  const note = customerQ.data?.notes?.trim();
  const loading = !!id && tagsQ.isLoading && !fallback?.length;
  const failed = !!tagsQ.error && !fallback?.length;

  return (
    <div className="cust-tags">
      {heading && <div className="eyebrow">Tags and preferences</div>}
      {loading && <div className="muted small">Loading tags…</div>}
      {failed && <div className="warn small">Couldn't load this customer's tags.</div>}
      {!loading && !failed && !tags.length && !note && <div className="muted small">No tags or preferences on file.</div>}
      {prefs.length > 0 && (
        <div className="sch-reasons">
          {prefs.map((p) => (
            <span key={p.text} className={`sch-reason t-${p.tone}`}>{p.text}</span>
          ))}
        </div>
      )}
      {tags.length > 0 && (
        <div className="chips">
          {tags.map((t) => (
            <span key={t.id ?? t.name} className="chip">{t.name}</span>
          ))}
        </div>
      )}
      {note && <p className="pre small cust-tags-note"><span className="muted">Profile note:</span> {note}</p>}
    </div>
  );
}
