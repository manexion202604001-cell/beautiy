-- Track actual sender when message is sent on behalf of assigned staff
ALTER TABLE messages ADD COLUMN sent_by_staff_id TEXT;
