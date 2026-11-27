// The conversation toolbar's "Complaint" button: opens the complaint already made for this
// conversation, or makes one (prefilled from the conversation) and opens it. Beside it,
// "Positive feedback" puts the conversation on the Input to UM Portal - Positive Feedback list.
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inbox, type ConversationDetail } from '../inbox/api';
import { insights } from '../lib/customer360';
import type { Booking } from '../types';
import { tracker } from './api';

export function ComplaintButtons({ detail }: { detail: ConversationDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const c = detail.conversation;
  const key = ['tracker', 'conversation', c.id];
  const linked = useQuery({ queryKey: key, queryFn: () => tracker.forConversation(c.id), staleTime: 15_000 });
  const open = linked.data?.complaints.find((r) => r.state !== 'done');
  const open_ = useMutation({
    mutationFn: async () => {
      if (open) return open.id;
      // LTV of Client: lifetime spend, when the customer panel has already loaded their visits.
      const cid = detail.contact?.l27_customer_id;
      const past = cid ? queryClient.getQueryData<Booking[]>(['customer', String(cid), '360', 'past']) : undefined;
      const ltv = past ? Math.round(insights(past as never, []).spend) : null;
      const made = await tracker.create({ conversation_id: c.id, ltv_of_client: ltv, complaint_notes: c.complaint?.issue || null });
      // Keep the conversation's own complaint mark: Cleaner reports count complaints from it.
      if (!made.existing && !c.complaint) await inbox.patch(c.id, { complaint: { booking_id: c.l27_booking_id, status: 'open', outcome: 'pending' } });
      return made.record.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ['tracker'], predicate: (q) => q.queryKey[1] !== 'meta' });
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
      navigate(`/complaint-tracking/${id}`);
    },
  });
  const positive = linked.data?.positive;
  const waiting = !!positive && !positive.done_at;
  const flag = useMutation({ mutationFn: () => tracker.setPositive(c.id, waiting ? 'clear' : 'flag'), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracker'], predicate: (q) => q.queryKey[1] !== 'meta' }) });
  const error = (open_.error || flag.error) as Error | null;
  return (
    <>
      <button className="secondary" disabled={open_.isPending} title={open ? `Open "${open.title}"` : 'Start a complaint for this conversation'} onClick={() => open_.mutate()}>{open ? 'Complaint ●' : c.complaint || linked.data?.complaints.length ? 'Complaint ✓' : 'Complaint'}</button>
      <button className="secondary" disabled={flag.isPending} title={waiting ? 'Waiting to be entered in the UM Portal. Click to take it off the list.' : positive?.done_at ? 'Entered in the UM Portal. Click to list it again.' : 'A client praised a cleaner: list it for entry in the UM Portal'} onClick={() => flag.mutate()}>{waiting ? 'Positive feedback ●' : positive?.done_at ? 'Positive feedback ✓' : 'Positive feedback'}</button>
      {error && <span className="error small">{error.message}</span>}
    </>
  );
}
