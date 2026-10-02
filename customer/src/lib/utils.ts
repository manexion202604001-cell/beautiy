import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Parse DB datetime string as UTC (SQLite datetime('now') stores UTC without timezone indicator)
function parseUTCDate(dateStr: string | Date): Date {
  if (typeof dateStr !== "string") return dateStr;
  if (/Z|[+-]\d{2}:\d{2}$/.test(dateStr)) return new Date(dateStr);
  // Date-only format "YYYY-MM-DD" → treat as UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return new Date(dateStr + "T00:00:00Z");
  return new Date(dateStr.replace(" ", "T") + "Z");
}

export function formatDate(date: string | Date): string {
  const d = parseUTCDate(date);
  return d.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatTime(date: string | Date): string {
  const d = parseUTCDate(date);
  return d.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateTime(date: string | Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

export function formatPrice(price: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
  }).format(price);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}分`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}時間${mins}分` : `${hours}時間`;
}

export function getReservationStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "確認待ち",
    confirmed: "確定",
    cancelled: "キャンセル",
    completed: "完了",
  };
  return labels[status] || status;
}

export function getReservationStatusColor(status: string): string {
  const colors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    confirmed: "bg-green-100 text-green-800",
    cancelled: "bg-red-100 text-red-800",
    completed: "bg-gray-100 text-gray-800",
  };
  return colors[status] || "bg-gray-100 text-gray-800";
}
