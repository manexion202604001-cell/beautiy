-- =====================================================================
-- 0185 LINE (LIFF) — 友だち追加URL と LINE 経由の受付
--   line_channels.friend_url: the official account's 友だち追加 URL (https://lin.ee/...), shown to
--     customers wherever Salon OS asks them to add the account as a friend.
--   walkin_intakes.line_*: the LINE user who filled the reception form inside LINE (LIFF id token
--     verified by the API). When staff link the intake to a customer or register a new one, that
--     LINE user is linked to the customer.
-- =====================================================================
ALTER TABLE line_channels ADD COLUMN friend_url text;

ALTER TABLE walkin_intakes
  ADD COLUMN line_channel_id   uuid REFERENCES line_channels(id) ON DELETE SET NULL,
  ADD COLUMN line_user_id      text,
  ADD COLUMN line_display_name text;
