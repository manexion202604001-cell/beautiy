import { api } from '../lib/api';
import type { MenuDetail } from './types';
import type { SbMenuItem } from '../routes/app/menus/sbImportScripts';

/** サロンボードから取込 (apps/api modules/catalog/sbImport.ts) */

export type SbMenuKind = 'regular' | 'coupon';

export interface SbChange {
  label: '掲載' | '〜表示' | 'クーポン種別' | '価格' | '時間' | '説明' | 'カテゴリ' | '表記';
  from: string;
  to: string;
}

export interface SbPreviewRow {
  index: number;
  kind: 'new' | 'update' | 'same';
  item: {
    name: string;
    category: string | null;
    description: string | null;
    price: number;
    durationMin: number;
    priceTilde: boolean;
    listed: boolean;
    couponType: 'all' | 'new' | 'repeat' | null;
  };
  existing: {
    id: string;
    name: string;
    categoryName: string | null;
    price: number;
    durationMin: number;
    listed: boolean;
    priceTilde: boolean;
    couponType: string | null;
    description: string | null;
  } | null;
  changes: SbChange[];
  selected: boolean;
}

export interface SbMissingRow {
  id: string;
  name: string;
  categoryName: string | null;
  price: number;
  durationMin: number;
}

export interface SbImportResult {
  created: number;
  updated: number;
  hidden: number;
  skipped: number;
  images: { menuId: string; url: string }[];
}

export const sbImportApi = {
  preview: (input: { shopId: string; kind: SbMenuKind; items: SbMenuItem[] }) =>
    api.post<{ rows: SbPreviewRow[]; missing: SbMissingRow[]; invalid: number }>(
      '/menus/sb-import/preview',
      input,
    ),
  run: (input: {
    shopId: string;
    mode: 'compare' | 'single';
    kind?: SbMenuKind;
    items: SbMenuItem[];
    selected?: number[];
    overwriteDetails?: boolean;
    hideMenuIds?: string[];
  }) => api.post<SbImportResult>('/menus/sb-import', input),
  staffAssignments: (input: { shopId: string; staffNames?: string[]; assignments: unknown[] }) =>
    api.post<{ message: string }>('/menus/import/staff-assignments', input),
  equipmentAssignments: (input: {
    shopId: string;
    equipmentNames?: string[];
    assignments: unknown[];
  }) => api.post<{ message: string }>('/menus/import/equipment-assignments', input),
  categories: (input: { shopId: string; groups: { parent: string; children: string[] }[] }) =>
    api.post<{ parents: number; children: number; skipped: number; message: string }>(
      '/menu-categories/import',
      input,
    ),
  /** the server fetches the SALON BOARD picture and makes it the menu's picture */
  imageFromUrl: (menuId: string, url: string) =>
    api.post<MenuDetail>(`/menus/${menuId}/image-from-url`, { url }),
};

/** Fetches the SALON BOARD pictures of imported menus one by one; a picture that fails is left out */
export async function importSbImages(images: { menuId: string; url: string }[]): Promise<number> {
  let done = 0;
  for (const { menuId, url } of images) {
    try {
      await sbImportApi.imageFromUrl(menuId, url);
      done += 1;
    } catch {
      // SALOGIC also carries on without the picture
    }
  }
  return done;
}
