import type { Ctx } from '../../auth/actor.js';
import { signedUrlFor } from '../files/api.js';

/** Staff photos are shown in lists that stay open (calendar, staff screen): links last an hour */
const AVATAR_URL_TTL_SEC = 3600;

export function photoFileIdOf(publicProfile: unknown): string | null {
  const p = (publicProfile ?? {}) as Record<string, unknown>;
  const id = p.photoFileId ?? p.photo_file_id;
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** staffId → short-lived URL of the profile photo (staff without an uploaded photo are absent) */
export async function staffAvatarUrls(ctx: Ctx, staff: { id: string; public_profile: unknown }[]): Promise<Map<string, string>> {
  const byFile = new Map<string, string[]>();
  for (const s of staff) {
    const fileId = photoFileIdOf(s.public_profile);
    if (fileId) byFile.set(fileId, [...(byFile.get(fileId) ?? []), s.id]);
  }
  const out = new Map<string, string>();
  if (!byFile.size) return out;
  const files = await ctx.trx
    .selectFrom('files')
    .select(['id', 'object_key', 'file_name'])
    .where('id', 'in', [...byFile.keys()])
    .where('purpose', '=', 'staff_photo')
    .where('status', '=', 'uploaded')
    .execute();
  for (const f of files) {
    const { url } = await signedUrlFor(f, { ttlSec: AVATAR_URL_TTL_SEC });
    for (const staffId of byFile.get(f.id) ?? []) out.set(staffId, url);
  }
  return out;
}
