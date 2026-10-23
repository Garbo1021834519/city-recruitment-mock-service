ALTER TABLE unknown_questions
  ADD COLUMN converted_knowledge_id INTEGER REFERENCES knowledge_items(id) ON DELETE SET NULL;

ALTER TABLE unknown_questions
  ADD COLUMN converted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_unknown_questions_converted_knowledge_id
  ON unknown_questions(converted_knowledge_id);
