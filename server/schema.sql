CREATE TABLE IF NOT EXISTS plans (code text PRIMARY KEY, name text NOT NULL, max_branches integer NOT NULL, max_users integer NOT NULL,
  price_month integer NOT NULL, active boolean NOT NULL DEFAULT true);
-- Placeholder prices in KES, not market-validated. Change with PATCH /api/platform/plans/:code.
INSERT INTO plans(code,name,max_branches,max_users,price_month) VALUES ('starter','Starter',1,3,1500),('business','Business',3,10,4500),('growth','Growth',10,30,12000) ON CONFLICT (code) DO NOTHING;
CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, plan_code text NOT NULL DEFAULT 'starter' REFERENCES plans(code),
  period_end timestamptz NOT NULL DEFAULT now() + interval '14 days', paid boolean NOT NULL DEFAULT false,
  sale_seq integer NOT NULL DEFAULT 0, po_seq integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','manager','cashier','storekeeper')), active boolean NOT NULL DEFAULT true,
  is_platform boolean NOT NULL DEFAULT false, must_change_password boolean NOT NULL DEFAULT false,
  password_changed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, address text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (business_id, name));
CREATE TABLE IF NOT EXISTS user_branches (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE, PRIMARY KEY (user_id, branch_id));
CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, name text NOT NULL, UNIQUE (business_id, name));
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sku text NOT NULL, barcode text, name text NOT NULL, category_id uuid REFERENCES categories(id), unit text NOT NULL DEFAULT 'pcs',
  cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0), price numeric(14,2) NOT NULL CHECK (price >= 0),
  reorder_level numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (business_id, sku));
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode ON products(business_id, barcode) WHERE barcode IS NOT NULL;
CREATE TABLE IF NOT EXISTS stock_balances (
  product_id uuid NOT NULL REFERENCES products(id), branch_id uuid NOT NULL REFERENCES branches(id),
  qty numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty >= 0), PRIMARY KEY (product_id, branch_id));
CREATE TABLE IF NOT EXISTS stock_movements (
  id bigserial PRIMARY KEY, business_id uuid NOT NULL, branch_id uuid NOT NULL REFERENCES branches(id), product_id uuid NOT NULL REFERENCES products(id),
  type text NOT NULL CHECK (type IN ('opening','purchase','sale','sale_return','adjustment','transfer_in','transfer_out')),
  qty numeric(14,3) NOT NULL CHECK (qty <> 0), unit_cost numeric(14,2), ref_type text, ref_id uuid, reason text, actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS movements_product ON stock_movements(product_id, branch_id, id);
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'stock_movements is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stock_movements_append_only ON stock_movements;
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, phone text, email text, address text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, phone text, email text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id), supplier_id uuid NOT NULL REFERENCES suppliers(id), number integer NOT NULL,
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','partial','received','cancelled')), notes text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (business_id, number));
CREATE TABLE IF NOT EXISTS purchase_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), po_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id),
  qty_ordered numeric(14,3) NOT NULL CHECK (qty_ordered > 0), unit_cost numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
  qty_received numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0));
CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id), number integer NOT NULL, cashier_id uuid NOT NULL REFERENCES users(id), customer_id uuid REFERENCES customers(id),
  subtotal numeric(14,2) NOT NULL, discount numeric(14,2) NOT NULL DEFAULT 0, total numeric(14,2) NOT NULL, idem_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (business_id, number), UNIQUE (business_id, idem_key));
CREATE INDEX IF NOT EXISTS sales_business_created ON sales(business_id, created_at);
CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id),
  name text NOT NULL, qty numeric(14,3) NOT NULL CHECK (qty > 0), unit_price numeric(14,2) NOT NULL, unit_cost numeric(14,2) NOT NULL,
  line_total numeric(14,2) NOT NULL, refunded_qty numeric(14,3) NOT NULL DEFAULT 0 CHECK (refunded_qty >= 0));
CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS sale_items_product ON sale_items(product_id);
CREATE TABLE IF NOT EXISTS sale_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('cash','mpesa','card','bank')), amount numeric(14,2) NOT NULL CHECK (amount > 0), tendered numeric(14,2), reference text);
CREATE TABLE IF NOT EXISTS sale_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE, sale_item_id uuid NOT NULL REFERENCES sale_items(id),
  business_id uuid NOT NULL, branch_id uuid NOT NULL, qty numeric(14,3) NOT NULL CHECK (qty > 0), amount numeric(14,2) NOT NULL,
  reason text NOT NULL, method text NOT NULL, actor_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS refunds_business_created ON sale_refunds(business_id, created_at);
CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id), category text NOT NULL, amount numeric(14,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash','mpesa','bank','card')), note text, spent_on date NOT NULL, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS expenses_business_date ON expenses(business_id, spent_on);
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES plans(code), months integer NOT NULL CHECK (months > 0), amount integer NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('mpesa','manual')), status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  phone text, checkout_request_id text UNIQUE, mpesa_receipt text, reference text, created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz);
CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purpose text NOT NULL CHECK (purpose IN ('invite','reset')), email text NOT NULL,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE, role text, user_id uuid REFERENCES users(id) ON DELETE CASCADE, detail jsonb NOT NULL DEFAULT '{}',
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY, business_id uuid NOT NULL, actor_id uuid, action text NOT NULL, entity text NOT NULL, entity_id text,
  detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS audit_business ON audit_logs(business_id, created_at DESC);

-- v2: tax and eTIMS queue, credit sales, payables, cash-up, batches and expiry, variants, till M-Pesa, SMS, MFA
CREATE TABLE IF NOT EXISTS business_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  legal_name text, kra_pin text, address text, phone text, receipt_footer text,
  vat_registered boolean NOT NULL DEFAULT false, etims_enabled boolean NOT NULL DEFAULT false,
  require_cash_session boolean NOT NULL DEFAULT false, sms_receipts boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS tax_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code text NOT NULL, name text NOT NULL, rate numeric(5,2) NOT NULL CHECK (rate >= 0 AND rate <= 100), UNIQUE (business_id, code));
ALTER TABLE products ADD COLUMN IF NOT EXISTS group_name text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_class_id uuid REFERENCES tax_classes(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_batches boolean NOT NULL DEFAULT false;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS tax_amount numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_total numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS offline boolean NOT NULL DEFAULT false;
ALTER TABLE sale_refunds ADD COLUMN IF NOT EXISTS tax numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sale_payments DROP CONSTRAINT IF EXISTS sale_payments_method_check;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_method_check CHECK (method IN ('cash','mpesa','card','bank','credit'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0);
CREATE TABLE IF NOT EXISTS customer_ledger (
  id bigserial PRIMARY KEY, business_id uuid NOT NULL, customer_id uuid NOT NULL REFERENCES customers(id),
  type text NOT NULL CHECK (type IN ('sale','payment','refund','adjustment')), amount numeric(14,2) NOT NULL CHECK (amount <> 0),
  method text, reference text, ref_id uuid, branch_id uuid, note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS customer_ledger_c ON customer_ledger(customer_id, id);
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, supplier_id uuid NOT NULL REFERENCES suppliers(id),
  po_id uuid REFERENCES purchase_orders(id), invoice_no text NOT NULL, invoice_date date NOT NULL, due_date date NOT NULL, amount numeric(14,2) NOT NULL CHECK (amount > 0),
  notes text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (business_id, supplier_id, invoice_no));
CREATE TABLE IF NOT EXISTS supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, invoice_id uuid NOT NULL REFERENCES supplier_invoices(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0), method text NOT NULL CHECK (method IN ('cash','mpesa','bank','card')), reference text, paid_on date NOT NULL,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS cash_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, branch_id uuid NOT NULL REFERENCES branches(id),
  user_id uuid NOT NULL REFERENCES users(id), opened_at timestamptz NOT NULL DEFAULT now(), opening_float numeric(14,2) NOT NULL DEFAULT 0 CHECK (opening_float >= 0),
  closed_at timestamptz, counted_cash numeric(14,2), expected_cash numeric(14,2), variance numeric(14,2), note text);
CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_open ON cash_sessions(branch_id, user_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS stock_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products(id), branch_id uuid NOT NULL REFERENCES branches(id),
  batch_no text NOT NULL, expiry_date date, qty numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty >= 0), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (product_id, branch_id, batch_no));
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES stock_batches(id);
CREATE TABLE IF NOT EXISTS mpesa_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE, env text NOT NULL DEFAULT 'sandbox', shortcode text NOT NULL, party_b text NOT NULL,
  tx_type text NOT NULL DEFAULT 'CustomerPayBillOnline', consumer_key_enc text NOT NULL, consumer_secret_enc text NOT NULL, passkey_enc text NOT NULL,
  callback_secret text NOT NULL, enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS till_mpesa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, branch_id uuid NOT NULL, user_id uuid NOT NULL,
  phone text NOT NULL, amount numeric(14,2) NOT NULL, checkout_request_id text UNIQUE, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  receipt text, paid_amount numeric(14,2), sale_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS etims_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, sale_id uuid NOT NULL UNIQUE REFERENCES sales(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','not_connected')), attempts integer NOT NULL DEFAULT 0, last_error text,
  payload jsonb NOT NULL, response jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sms_log (
  id bigserial PRIMARY KEY, business_id uuid NOT NULL, sale_id uuid, phone text NOT NULL, ok boolean NOT NULL, detail text, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_enc text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_enc text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step bigint;
CREATE TABLE IF NOT EXISTS mfa_recovery (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash text NOT NULL, used_at timestamptz);
CREATE TABLE IF NOT EXISTS digest_log (business_id uuid NOT NULL, kind text NOT NULL, sent_on date NOT NULL, PRIMARY KEY (business_id, kind, sent_on));
