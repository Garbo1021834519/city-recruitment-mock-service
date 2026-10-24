CREATE TABLE IF NOT EXISTS message_events (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  device_code TEXT NOT NULL DEFAULT '',
  customer_id INTEGER,
  payload_hash TEXT NOT NULL,
  payload_summary TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES message_events(event_id),
  device_code TEXT NOT NULL DEFAULT '',
  customer_id INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','failed','succeeded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_message_id TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_deliveries_due ON message_deliveries(status, next_retry_at, id);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY,
  webhook_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('processed','duplicate','rejected')),
  payload_hash TEXT NOT NULL,
  payload_summary TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
