-- SamCart Orders Table
-- Stores order data from SamCart webhooks

CREATE TABLE IF NOT EXISTS samcart_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    samcart_order_id VARCHAR(255) UNIQUE,
    event_type VARCHAR(50) DEFAULT 'order',
    email VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    phone VARCHAR(50),
    product_name VARCHAR(500),
    product_id VARCHAR(255),
    order_total DECIMAL(10, 2),
    currency VARCHAR(10) DEFAULT 'USD',
    status VARCHAR(50) DEFAULT 'completed',
    raw_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for email lookups (linking to Typeform and onboarding)
CREATE INDEX IF NOT EXISTS idx_samcart_orders_email ON samcart_orders(LOWER(email));

-- Index for order ID lookups
CREATE INDEX IF NOT EXISTS idx_samcart_orders_samcart_id ON samcart_orders(samcart_order_id);
