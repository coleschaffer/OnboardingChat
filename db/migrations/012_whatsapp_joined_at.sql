-- Add WhatsApp join timestamp tracking
-- Used by Wasender webhook integration

ALTER TABLE typeform_applications
ADD COLUMN IF NOT EXISTS whatsapp_joined_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE business_owners
ADD COLUMN IF NOT EXISTS whatsapp_joined_at TIMESTAMP WITH TIME ZONE;

