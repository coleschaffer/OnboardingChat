-- Migration: Add Monday.com Business Owner tracking to samcart_orders
-- This allows us to store the Monday.com item ID after creating a Business Owner
-- when a SamCart purchase is received

ALTER TABLE samcart_orders ADD COLUMN IF NOT EXISTS monday_item_id VARCHAR(255);
ALTER TABLE samcart_orders ADD COLUMN IF NOT EXISTS monday_created_at TIMESTAMP WITH TIME ZONE;
