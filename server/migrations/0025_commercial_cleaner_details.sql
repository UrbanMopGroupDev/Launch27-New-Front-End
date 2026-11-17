-- Commercial workforce plan: cleaner details Launch27 doesn't hold (docs/commercial-workforce.md).
-- Entered by the Commercial lead on Commercial → Workforce plan → Commercial team.
--   gender: overrides the (F)/(M) code in the Launch27 team name; null = use Launch27's.
--   home_postal: where the cleaner lives. Only its postal area (first 3 characters) is shown on
--     the "Where cleaners live" map, and it never goes into a partner file.
--   pets_*: whether the cleaner is fine with dogs, cats or other pets ('ok' / 'no' / null = not asked).

ALTER TABLE commercial_cleaners ADD COLUMN IF NOT EXISTS gender text CHECK (gender IN ('F', 'M'));
ALTER TABLE commercial_cleaners ADD COLUMN IF NOT EXISTS home_postal text;
ALTER TABLE commercial_cleaners ADD COLUMN IF NOT EXISTS pets_dogs text CHECK (pets_dogs IN ('ok', 'no'));
ALTER TABLE commercial_cleaners ADD COLUMN IF NOT EXISTS pets_cats text CHECK (pets_cats IN ('ok', 'no'));
ALTER TABLE commercial_cleaners ADD COLUMN IF NOT EXISTS pets_other text CHECK (pets_other IN ('ok', 'no'));
ALTER TABLE commercial_cleaners ADD COLUMN IF NOT EXISTS pets_note text;
