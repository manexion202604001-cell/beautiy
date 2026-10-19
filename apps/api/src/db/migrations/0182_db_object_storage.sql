-- =====================================================================
-- 0182 Object storage inside PostgreSQL (STORAGE_DRIVER=db)
--   For deployments without an S3-compatible bucket (e.g. a single Render database): file bytes
--   live here, metadata stays in `files` as before. Blobs are reached only through signed URLs
--   (/v1/files/blob/:token) like the local driver, so the table has no organization_id; the object
--   key already starts with org/<organization id>/.
-- =====================================================================
CREATE TABLE storage_objects (
  object_key    text PRIMARY KEY,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  body          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
