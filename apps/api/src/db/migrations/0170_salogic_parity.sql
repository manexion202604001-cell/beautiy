-- SALOGIC parity (docs/salogic-parity.md): booking routes the salon records by hand when staff
-- take a reservation. 'phone' stays "電話（自社）"; the additions are
--   phone_hpb (電話（HPB）) / next_visit (次回予約) / instagram / minimo / nailie (ネイリー)
--   referral (友人) / practice_model (練習モデル) / redo (お直し)
-- minimo / nailie have no adapter: these are bookings staff copy in from the medium's own screen.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_source_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_source_check CHECK (source IN (
    'web','line','external','phone','walk_in','staff','import',
    'phone_hpb','next_visit','instagram','minimo','nailie','referral','practice_model','redo'
  ));
