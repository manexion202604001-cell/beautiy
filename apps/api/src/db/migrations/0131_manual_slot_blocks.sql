-- Manual slot blocks for booking media without a write API (Hot Pepper Beauty / SALON BOARD, LiME).
-- Instead of calling the provider, the push engine creates staff tasks:
--   action_required: block this slot on the medium (booking taken via another channel)
--   remove_required: reopen a slot we blocked earlier (booking cancelled / moved)
ALTER TABLE external_slot_blocks DROP CONSTRAINT IF EXISTS external_slot_blocks_state_check;
ALTER TABLE external_slot_blocks
  ADD CONSTRAINT external_slot_blocks_state_check
    CHECK (state IN ('pending','pushed','removed','error','action_required','remove_required')),
  ADD COLUMN manual boolean NOT NULL DEFAULT false,
  ADD COLUMN notified_at timestamptz,
  ADD COLUMN done_by uuid REFERENCES staffs(id),
  ADD COLUMN done_at timestamptz;

CREATE INDEX external_slot_blocks_manual_open_idx ON external_slot_blocks(organization_id, state)
  WHERE manual AND state IN ('action_required', 'remove_required');
