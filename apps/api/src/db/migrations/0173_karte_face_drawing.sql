-- =====================================================================
-- 0173 Karte face drawing (SALOGIC parity: カルテ編集 ›「フェイス描画」)
--   The drawing staff make on the face chart is stored like the karte photos (a file + a
--   karte_assets row) under its own asset type, one live drawing per karte.
-- =====================================================================
ALTER TABLE karte_assets DROP CONSTRAINT IF EXISTS karte_assets_asset_type_check;
ALTER TABLE karte_assets
  ADD CONSTRAINT karte_assets_asset_type_check CHECK (asset_type IN ('photo_before','photo_after','photo','sketch','document','face_drawing'));
