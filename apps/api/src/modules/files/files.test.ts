import { describe, expect, it } from 'vitest';
import { withSystem } from '../../db/tenant.js';
import { enqueue } from '../../jobs/queue.js';
import { signPayload } from '../../lib/crypto.js';
import { storage } from '../../lib/storage.js';
import { api, asSystem, createStaffUser, createTenant, getApp, runJobs, TEST_PNG, uploadTestFile } from '../../test/helpers.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')]);

function path(url: string) {
  const u = new URL(url);
  return u.pathname + u.search;
}

async function fetchBlob(url: string) {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: path(url) });
  return { status: res.statusCode, headers: res.headers, body: res.rawPayload };
}

async function presign(client: ReturnType<typeof api>, body: Record<string, unknown>) {
  return client.post('/v1/files/presign', { purpose: 'karte_photo', contentType: 'image/png', sizeBytes: TEST_PNG.length, ...body });
}

describe('files: presigned upload (local driver)', () => {
  it('presign → PUT blob → complete → short-lived download URL', async () => {
    const t = await createTenant();
    const pre = await presign(t.owner, { fileName: '施術前.png' });
    expect(pre.status).toBe(201);
    expect(pre.body.upload.method).toBe('PUT');
    expect(pre.body.upload.headers['content-type']).toBe('image/png');
    expect(pre.body.file.status).toBe('pending');
    const key = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select(['object_key', 'size_bytes']).where('id', '=', pre.body.fileId).executeTakeFirstOrThrow());
    expect(key.object_key).toMatch(new RegExp(`^org/${t.organizationId}/karte_photo/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.png$`));

    // not uploaded yet
    const early = await t.owner.post(`/v1/files/${pre.body.fileId}/complete`, {});
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('FILE_NOT_UPLOADED');

    const put = await api().put(path(pre.body.upload.url), TEST_PNG, { 'content-type': 'image/png' });
    expect(put.status).toBe(204);

    const done = await t.owner.post(`/v1/files/${pre.body.fileId}/complete`, {});
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'uploaded', sizeBytes: TEST_PNG.length, contentType: 'image/png', fileName: '施術前.png' });
    // idempotent
    expect((await t.owner.post(`/v1/files/${pre.body.fileId}/complete`, {})).status).toBe(200);

    const url = await t.owner.get(`/v1/files/${pre.body.fileId}/url`);
    expect(url.status).toBe(200);
    expect(url.body.contentType).toBe('image/png');
    const blob = await fetchBlob(url.body.url);
    expect(blob.status).toBe(200);
    expect(blob.headers['content-type']).toBe('image/png');
    expect(blob.headers['content-disposition']).toBe('inline');
    expect(Buffer.compare(blob.body, TEST_PNG)).toBe(0);

    const dl = await t.owner.get(`/v1/files/${pre.body.fileId}/url`, { download: 'true' });
    const blob2 = await fetchBlob(dl.body.url);
    expect(String(blob2.headers['content-disposition'])).toContain(`filename*=UTF-8''${encodeURIComponent('施術前.png')}`);

    // a blob PUT after completion is refused
    const again = await api().put(path(pre.body.upload.url), TEST_PNG, { 'content-type': 'image/png' });
    expect(again.status).toBe(409);

    const logs = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('audit_logs').select('action').where('resource_id', '=', pre.body.fileId).orderBy('id').execute(),
    );
    expect(logs.map((l) => l.action)).toEqual(['file.upload', 'file.download', 'file.download']);
  });

  it('rejects disallowed content types and oversized files', async () => {
    const t = await createTenant();
    const pdf = await presign(t.owner, { contentType: 'application/pdf' });
    expect(pdf.status).toBe(415);
    expect(pdf.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const svg = await presign(t.owner, { purpose: 'product_image', contentType: 'image/svg+xml' });
    expect(svg.status).toBe(415);
    const big = await presign(t.owner, { sizeBytes: 15 * 1024 * 1024 + 1 });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
    const sig = await presign(t.owner, { purpose: 'signature', sizeBytes: 2 * 1024 * 1024 });
    expect(sig.status).toBe(413);
    const badPurpose = await presign(t.owner, { purpose: 'avatar' });
    expect(badPurpose.status).toBe(400);
    // documents accept PDF
    expect((await presign(t.owner, { purpose: 'document', contentType: 'application/pdf' })).status).toBe(201);

    const pre = await presign(t.owner, { contentType: 'image/jpeg', sizeBytes: JPEG.length });
    // content-type must match the signed one
    const wrongCt = await api().put(path(pre.body.upload.url), JPEG, { 'content-type': 'image/png' });
    expect(wrongCt.status).toBe(415);
    // body larger than declared
    const tooBig = await api().put(path(pre.body.upload.url), Buffer.concat([JPEG, Buffer.alloc(100)]), { 'content-type': 'image/jpeg' });
    expect(tooBig.status).toBe(413);
    // bytes are not a JPEG
    const fake = await api().put(path(pre.body.upload.url), Buffer.from('<html>evil</html>').subarray(0, JPEG.length), { 'content-type': 'image/jpeg' });
    expect(fake.status).toBe(415);
    const ok = await api().put(path(pre.body.upload.url), JPEG, { 'content-type': 'image/jpeg' });
    expect(ok.status).toBe(204);
  });

  it('rejects tampered, expired and wrong-operation tokens', async () => {
    const t = await createTenant();
    const pre = await presign(t.owner, {});
    const token = new URL(pre.body.upload.url).pathname.split('/').pop()!;
    const [body, sig] = token.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), k: 'org/other/karte_photo/x.png' })).toString('base64url');
    const tampered = await api().put(`/v1/files/blob/${tamperedBody}.${sig}`, TEST_PNG, { 'content-type': 'image/png' });
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('INVALID_BLOB_TOKEN');
    const badSig = await api().put(`/v1/files/blob/${body}.${sig!.slice(0, -2)}xx`, TEST_PNG, { 'content-type': 'image/png' });
    expect(badSig.status).toBe(401);

    const key = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select('object_key').where('id', '=', pre.body.fileId).executeTakeFirstOrThrow());
    const expired = signPayload({ k: key.object_key, ct: 'image/png', op: 'put' }, -10);
    expect((await api().put(`/v1/files/blob/${expired}`, TEST_PNG, { 'content-type': 'image/png' })).status).toBe(401);

    // a download token cannot be used to upload (and vice versa)
    const getToken = signPayload({ k: key.object_key, op: 'get' }, 60);
    expect((await api().put(`/v1/files/blob/${getToken}`, TEST_PNG, { 'content-type': 'image/png' })).status).toBe(403);
    expect((await api().get(`/v1/files/blob/${token}`)).status).toBe(403);
    // pending files are not downloadable
    expect((await api().get(`/v1/files/blob/${getToken}`)).status).toBe(404);
    // the expired download token
    const expiredGet = signPayload({ k: key.object_key, op: 'get' }, -1);
    expect((await api().get(`/v1/files/blob/${expiredGet}`)).status).toBe(401);
  });

  it('verifies an optional checksum on complete', async () => {
    const t = await createTenant();
    const pre = await presign(t.owner, {});
    await api().put(path(pre.body.upload.url), TEST_PNG, { 'content-type': 'image/png' });
    const bad = await t.owner.post(`/v1/files/${pre.body.fileId}/complete`, { checksumSha256: 'a'.repeat(64) });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('CHECKSUM_MISMATCH');
    const { createHash } = await import('node:crypto');
    const good = await t.owner.post(`/v1/files/${pre.body.fileId}/complete`, { checksumSha256: createHash('sha256').update(TEST_PNG).digest('hex') });
    expect(good.status).toBe(200);
  });

  it('authorizes uploads and downloads by purpose', async () => {
    const t = await createTenant();
    const reception = await createStaffUser(t, 'reception');
    const stylist = await createStaffUser(t, 'stylist');
    const accountant = await createStaffUser(t, 'accountant');
    const accountant2 = await createStaffUser(t, 'accountant');

    // reception has no karte.write
    expect((await presign(reception.api, {})).status).toBe(403);
    // stylist cannot upload product images or exports
    expect((await presign(stylist.api, { purpose: 'product_image' })).status).toBe(403);

    // unattached karte photo: only the uploader can read it
    const photo = await uploadTestFile(stylist.api);
    expect((await stylist.api.get(`/v1/files/${photo.fileId}/url`)).status).toBe(200);
    expect((await t.owner.get(`/v1/files/${photo.fileId}/url`)).status).toBe(404);
    // only the uploader may complete
    const pre = await presign(stylist.api, {});
    await api().put(path(pre.body.upload.url), TEST_PNG, { 'content-type': 'image/png' });
    expect((await t.owner.post(`/v1/files/${pre.body.fileId}/complete`, {})).status).toBe(403);

    // product images are readable by any staff
    const product = await uploadTestFile(t.owner, { purpose: 'product_image' });
    expect((await reception.api.get(`/v1/files/${product.fileId}/url`)).status).toBe(200);

    // exports: export.data AND the requester
    const csv = Buffer.from('id,name\n1,テスト\n');
    const exp = await uploadTestFile(accountant.api, { purpose: 'export', contentType: 'text/csv', body: csv, fileName: 'customers.csv' });
    expect((await accountant.api.get(`/v1/files/${exp.fileId}/url`)).status).toBe(200);
    expect((await accountant2.api.get(`/v1/files/${exp.fileId}/url`)).status).toBe(404);
    expect((await stylist.api.get(`/v1/files/${exp.fileId}/url`)).status).toBe(403);
  });

  it('soft-deletes files and removes the object asynchronously', async () => {
    const t = await createTenant();
    const f = await uploadTestFile(t.owner);
    const key = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select('object_key').where('id', '=', f.fileId).executeTakeFirstOrThrow());
    expect(await storage.head(key.object_key)).not.toBeNull();
    const del = await t.owner.delete(`/v1/files/${f.fileId}`);
    expect(del.status).toBe(204);
    expect((await t.owner.get(`/v1/files/${f.fileId}/url`)).status).toBe(404);
    await runJobs();
    expect(await storage.head(key.object_key)).toBeNull();
    const row = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select(['status', 'deleted_at']).where('id', '=', f.fileId).executeTakeFirstOrThrow());
    expect(row.status).toBe('deleted');
  });

  it('discards stale pending uploads in the daily sweep', async () => {
    const t = await createTenant();
    const stale = await presign(t.owner, {});
    const fresh = await presign(t.owner, {});
    await api().put(path(stale.body.upload.url), TEST_PNG, { 'content-type': 'image/png' });
    const key = await asSystem(t.organizationId, async (ctx) => {
      await ctx.trx.updateTable('files').set({ created_at: new Date(Date.now() - 2 * 86_400_000) }).where('id', '=', stale.body.fileId).execute();
      return (await ctx.trx.selectFrom('files').select('object_key').where('id', '=', stale.body.fileId).executeTakeFirstOrThrow()).object_key;
    });
    await withSystem((trx) => enqueue(trx, { type: 'files.cleanup_pending', organizationId: null }));
    await runJobs();
    const rows = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select(['id', 'status']).where('id', 'in', [stale.body.fileId, fresh.body.fileId]).execute());
    expect(rows.find((r) => r.id === stale.body.fileId)!.status).toBe('deleted');
    expect(rows.find((r) => r.id === fresh.body.fileId)!.status).toBe('pending');
    expect(await storage.head(key)).toBeNull();
  });

  it('isolates tenants', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const f = await uploadTestFile(a.owner);
    expect((await b.owner.get(`/v1/files/${f.fileId}/url`)).status).toBe(404);
    expect((await b.owner.get(`/v1/files/${f.fileId}`)).status).toBe(404);
    expect((await b.owner.post(`/v1/files/${f.fileId}/complete`, {})).status).toBe(404);
    expect((await b.owner.delete(`/v1/files/${f.fileId}`)).status).toBe(404);
  });
});
