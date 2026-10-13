-- Application role and databases for local development and CI.
-- Run once as the cluster admin (POSTGRES_USER): docker-compose mounts this file into
-- /docker-entrypoint-initdb.d, CI pipes it into psql (.github/workflows/ci.yml).
--
-- `salon` must NOT be a superuser and must NOT have BYPASSRLS: PostgreSQL skips every row-level
-- security policy for such roles (FORCE ROW LEVEL SECURITY does not change that), which would
-- silently disable tenant isolation (apps/api/src/db/migrations/0090_row_level_security.sql).
-- It owns its databases so that it can create the trusted extensions (btree_gist, citext, pg_trgm)
-- and recreate schema public (db:reset / test global-setup).
CREATE ROLE salon LOGIN PASSWORD 'salon' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOREPLICATION CREATEDB;

-- UTF-8 locale on purpose: with LC_CTYPE "C", pg_trgm ignores non-ASCII letters and the
-- similarity-based duplicate detection never matches kana / kanji names.
-- development database (DATABASE_URL)
CREATE DATABASE salon OWNER salon TEMPLATE template0 ENCODING 'UTF8' LOCALE 'en_US.UTF-8';
-- test database used by `pnpm --filter @salon/api test` (TEST_DATABASE_URL)
CREATE DATABASE salon_test OWNER salon TEMPLATE template0 ENCODING 'UTF8' LOCALE 'en_US.UTF-8';
