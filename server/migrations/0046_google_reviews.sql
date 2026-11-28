-- Google reviews, imported from a Google Business Profile export (Takeout "reviews-*.json"), and
-- matched to the complaint they followed (server/src/complaints/reviews.js). A matched 1-2 star
-- review makes the complaint's outcome LOST, whatever the client's bookings say.
CREATE TABLE IF NOT EXISTS google_reviews (
  review_id text PRIMARY KEY,            -- Google's own name for the review
  reviewer_name text,
  stars int NOT NULL,
  comment text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  reply text,
  reply_at timestamptz,
  case_id bigint REFERENCES complaint_cases(id) ON DELETE SET NULL,
  contact_id bigint,                     -- a contact with exactly this name, when there is one
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by bigint REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS google_reviews_case ON google_reviews (case_id);
