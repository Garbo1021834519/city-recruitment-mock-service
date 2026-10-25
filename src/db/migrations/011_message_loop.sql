ALTER TABLE agent_conversations ADD COLUMN external_conversation_id TEXT;
ALTER TABLE agent_messages ADD COLUMN source_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_source_event
  ON agent_messages(source_event_id,direction)
  WHERE source_event_id IS NOT NULL AND source_event_id<>'';
