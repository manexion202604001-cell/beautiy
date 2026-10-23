/**
 * メニュー画像を URL から取り込む (POST /v1/menus/:id/image-from-url).
 *
 * The SALON BOARD import scripts hand over the picture of a menu / coupon as a URL on SALON BOARD's
 * image host. The server downloads it and stores it like an uploaded picture (purpose 'menu_image').
 * Only https URLs on SALON BOARD hosts are fetched, so the endpoint cannot be used to make the server
 * reach arbitrary (internal) addresses; redirects are followed by hand and re-checked at every hop.
 */
import { requirePermission, assertShopAccess, type Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';
import { createFileRecord } from '../files/api.js';
import { PURPOSE_POLICIES, baseContentType } from '../files/policy.js';
import { getMenu, updateMenu } from './service.js';

/** Hosts (and their sub-domains) a menu picture may be fetched from: SALON BOARD's image servers */
export const SB_IMAGE_HOSTS = ['salonboard.com'] as const;

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = PURPOSE_POLICIES.menu_image.maxBytes;
const ACCEPTED_TYPES: readonly string[] = PURPOSE_POLICIES.menu_image.contentTypes;

const INVALID_URL = 'サロンボードの画像URLではありません';

/** https on a SALON BOARD host, default port, no user info — otherwise a validation error */
export function assertSbImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw Errors.validation(INVALID_URL);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = SB_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (url.protocol !== 'https:' || !allowed || url.port !== '' || url.username || url.password)
    throw Errors.validation(INVALID_URL, { url: raw });
  return url;
}

/** Reads a response body, refusing more than `max` bytes */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max)
    throw Errors.validation(`画像が大きすぎます（${Math.round(max / 1024 / 1024)}MBまで）`);
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw Errors.validation(`画像が大きすぎます（${Math.round(max / 1024 / 1024)}MBまで）`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Downloads a SALON BOARD picture: JPEG / PNG / WebP up to the menu picture size limit */
export async function fetchSbImage(
  raw: string,
): Promise<{ body: Buffer; contentType: string; fileName: string | null }> {
  let url = assertSbImageUrl(raw);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: ACCEPTED_TYPES.join(', ') },
      });
    } catch {
      throw Errors.external('salonboard', '画像を取得できませんでした');
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS)
        throw Errors.external('salonboard', '画像を取得できませんでした');
      url = assertSbImageUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw Errors.external('salonboard', `画像を取得できませんでした（${res.status}）`);
    const contentType = baseContentType(res.headers.get('content-type'));
    if (!ACCEPTED_TYPES.includes(contentType))
      throw Errors.validation('JPEG・PNG・WebP の画像だけ取り込めます', { contentType });
    const body = await readCapped(res, MAX_BYTES);
    if (!body.length) throw Errors.external('salonboard', '画像を取得できませんでした');
    const fileName = decodeURIComponent(url.pathname.split('/').pop() ?? '') || null;
    return { body, contentType, fileName };
  }
}

/** Checks that the actor may change the menu's picture (before anything is downloaded) */
export async function assertMenuImageWritable(ctx: Ctx, menuId: string) {
  requirePermission(ctx.actor, 'menu.manage');
  const menu = await getMenu(ctx, menuId);
  if (menu.shop_id) assertShopAccess(ctx.actor, menu.shop_id);
  else if (ctx.actor.kind === 'staff' && !ctx.actor.allShops)
    throw Errors.forbidden(
      '共通メニューの編集には全店舗権限が必要です（店舗別上書きを使用してください）',
    );
}

/** Stores a downloaded picture and makes it the menu's picture (the previous one is released) */
export async function setMenuImage(
  ctx: Ctx,
  menuId: string,
  image: { body: Buffer; contentType: string; fileName: string | null },
) {
  const file = await createFileRecord(ctx, {
    purpose: 'menu_image',
    contentType: image.contentType,
    body: image.body,
    fileName: image.fileName,
  });
  return updateMenu(ctx, menuId, { imageFileId: file.id });
}
