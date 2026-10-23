CREATE TABLE IF NOT EXISTS activation_strategy_rules (
  code TEXT PRIMARY KEY CHECK (code IN ('no_reply','date_trigger','misjudge','paused')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
