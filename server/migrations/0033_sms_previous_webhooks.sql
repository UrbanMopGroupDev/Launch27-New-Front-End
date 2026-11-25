-- Where each Twilio number sent its incoming texts before an admin moved them to the portal
-- (Support settings → Channels → "Send incoming texts to the portal"), so "Hand back" can put
-- them back exactly: { "+16135550100": { "sms_url", "sms_method", "sms_application_sid", "saved_at" } }.
ALTER TABLE sms_provider_state ADD COLUMN IF NOT EXISTS previous_webhooks jsonb;
