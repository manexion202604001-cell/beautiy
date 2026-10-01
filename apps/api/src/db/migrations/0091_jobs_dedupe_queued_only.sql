-- Dedupe only against queued jobs: a job enqueued while an identical job is running must not be dropped
-- (otherwise changes committed mid-run are lost, e.g. analytics rebuilds).
DROP INDEX IF EXISTS jobs_dedupe_idx;
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND state = 'queued';
