// Google reviews against complaints. Reviews come from a Google Business Profile export
// (Takeout: files named reviews-*.json, each { reviews: [...] }); an admin uploads them on the
// Complaint playbook. Each review is matched to the complaint it followed by the reviewer's
// name and the dates, so we can see which threats became reviews, what we had offered first,
// and count a 1-2 star review as a lost client. Pure functions here; storage is in service.js.
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const DAY = 86_400_000;
// A review is tied to a complaint opened up to this long before it (or shortly after: some
// clients post first and write to us second).
export const REVIEW_AFTER_DAYS = 60;
export const REVIEW_BEFORE_DAYS = 14;

/** Rows from one export file. Unknown shapes give []; rows without an id, stars or date are dropped. */
export function parseTakeout(json) {
  const list = Array.isArray(json?.reviews) ? json.reviews : Array.isArray(json) ? json : [];
  return list
    .map((r) => ({
      review_id: typeof r?.name === 'string' ? r.name.slice(0, 500) : null,
      reviewer_name: String(r?.reviewer?.displayName || '').slice(0, 200) || null,
      stars: STARS[r?.starRating] ?? (Number.isInteger(r?.starRating) ? r.starRating : null),
      comment: typeof r?.comment === 'string' ? r.comment.slice(0, 8000) : null,
      created_at: r?.createTime || null,
      updated_at: r?.updateTime || null,
      reply: typeof r?.reviewReply?.comment === 'string' ? r.reviewReply.comment.slice(0, 8000) : null,
      reply_at: r?.reviewReply?.updateTime || null,
    }))
    .filter((r) => r.review_id && r.stars >= 1 && r.stars <= 5 && r.created_at && !Number.isNaN(Date.parse(r.created_at)));
}

/** A name for matching: lower case, accents and punctuation removed. Null unless it has a first and a last name. */
export function nameKey(name) {
  const parts = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter((p) => p.length >= 2);
  return parts.length >= 2 ? parts.join(' ') : null;
}

/**
 * The complaint a review followed: same full name, complaint opened within the window around
 * the review; the closest one wins. cases: [{ id, customer_name, opened_at }]. Returns an id or null.
 * A single name, initials or a business name never matches: better no link than a wrong one.
 */
export function matchCase(review, cases) {
  const key = nameKey(review.reviewer_name);
  if (!key) return null;
  const at = Date.parse(review.created_at);
  const near = cases
    .filter((c) => nameKey(c.customer_name) === key)
    .map((c) => ({ id: c.id, gap: at - new Date(c.opened_at).getTime() }))
    .filter((c) => c.gap <= REVIEW_AFTER_DAYS * DAY && c.gap >= -REVIEW_BEFORE_DAYS * DAY)
    .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
  return near[0]?.id ?? null;
}
