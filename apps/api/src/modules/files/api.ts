/**
 * PUBLIC CONTRACT of the files module — other modules (data exports, SNS assets, products, kartes...)
 * use these instead of touching `files` / object storage directly.
 *
 *  - createFileRecord(ctx, { purpose, contentType, body, fileName })  server-side upload (caller authorizes)
 *  - getDownloadUrl(ctx, fileId, { ttlSec?, download? })             authorized short-lived URL (audited for personal data)
 *  - getAttachableFile(ctx, fileId, purposes)                          uploaded file of an allowed purpose, same org
 *  - signedUrlFor(file, opts)                                          signer for reads the caller already authorized
 *  - readFileBytes(file)                                               raw bytes (e.g. hash verification)
 *  - markFileDeleted(ctx, fileId)                                      soft delete + async object deletion
 */
export {
  assertFileReadable,
  createFileRecord,
  DOWNLOAD_URL_TTL_SEC,
  fileView,
  getAttachableFile,
  getDownloadUrl,
  markFileDeleted,
  readFileBytes,
  signedUrlFor,
  type FileRow,
} from './service.js';
export { FILE_PURPOSES, PURPOSE_POLICIES, type FilePurpose } from './policy.js';
