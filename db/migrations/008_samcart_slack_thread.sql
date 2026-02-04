-- Add Slack thread tracking to samcart_orders
-- The welcome message will be threaded on the SamCart notification

ALTER TABLE samcart_orders ADD COLUMN IF NOT EXISTS slack_channel_id VARCHAR(50);
ALTER TABLE samcart_orders ADD COLUMN IF NOT EXISTS slack_thread_ts VARCHAR(50);
