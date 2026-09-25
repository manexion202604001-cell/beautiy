// Serializable shapes passed from the ledger page (server) to the client components.
import type { LedgerAppt, LedgerDay } from '@/lib/server/reservations';

export type { LedgerAppt, LedgerDay };

export interface ShopInfo { id: string; name: string; timezone: string; slotIntervalMin: number; seatCount: number; slug: string }
export interface StaffColumn { staffId: string; name: string; imageUrl: string | null }
export interface ForeignBlock { staffId: string; date: string; startMin: number; endMin: number; shopName: string }
export interface StaffOption { userId: string; name: string; bookable: boolean }
export interface MenuOption { id: string; category: string; name: string; price: number; durationMin: number; isConsultation: boolean }
export interface CouponOption { id: string; name: string; discountType: string; discountValue: number; menuIds: string[]; label: string }
export interface PendingRequest { id: string; date: string; time: string; name: string; source: string }
export interface Perms { write: boolean; customerRead: boolean; customerWrite: boolean }

export interface CreatePreset {
  date: string;
  startMin: number;
  staffMode: 'staff' | 'auto' | 'none';
  staffId?: string | null;
  customer?: { id: string; name: string; kana: string; phone: string; visitCount: number; lastVisitAt: string | null } | null;
  newName?: string;
  newPhone?: string;
  guestName?: string;
  note?: string;
  waitlistId?: string;
}

export type DrawerMode = { kind: 'create'; preset: CreatePreset } | { kind: 'edit'; id: string };
