-- =====================================================================
-- 0174 Thread notes (SALOGIC parity: メッセージ)
--   The previous system keeps every staff message in its own chat and pushes it through LINE
--   only when the customer has linked LINE; otherwise the message is recorded on the thread and
--   the customer gets nothing. Salon OS delivers each message through exactly one channel, so a
--   message that is recorded without being delivered gets its own channel value:
--     channel = 'note', status = 'skipped', skip_reason = 'note_only'
--   No delivery job is ever queued for it.
-- =====================================================================
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_channel_check CHECK (channel IN ('line','email','sms','note'));
