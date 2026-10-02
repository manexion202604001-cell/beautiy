import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Parse DB datetime string as UTC (SQLite datetime('now') stores UTC without timezone indicator)
function parseUTCDate(dateStr: string | Date): Date {
  if (typeof dateStr !== "string") return dateStr;
  // Already has timezone info (Z or +HH:MM) — parse as-is
  if (/Z|[+-]\d{2}:\d{2}$/.test(dateStr)) return new Date(dateStr);
  // Date-only format "YYYY-MM-DD" → treat as UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return new Date(dateStr + "T00:00:00Z");
  // DB format "YYYY-MM-DD HH:MM:SS" → treat as UTC
  return new Date(dateStr.replace(" ", "T") + "Z");
}

// Date formatting (always in JST)
export function formatDate(dateStr: string | Date, format: "date" | "time" | "datetime" | "short" = "datetime"): string {
  const date = parseUTCDate(dateStr);

  // Always use Asia/Tokyo timezone for consistent display
  const timeZone = "Asia/Tokyo";

  switch (format) {
    case "date":
      return date.toLocaleDateString("ja-JP", {
        timeZone,
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
      });
    case "time":
      return date.toLocaleTimeString("ja-JP", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
      });
    case "short":
      return date.toLocaleDateString("ja-JP", {
        timeZone,
        month: "short",
        day: "numeric",
      });
    case "datetime":
    default:
      return date.toLocaleString("ja-JP", {
        timeZone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  }
}

// Price formatting
export function formatPrice(price: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
  }).format(price);
}

// Duration formatting (minutes to hours:minutes)
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) {
    return `${mins}分`;
  }
  if (mins === 0) {
    return `${hours}時間`;
  }
  return `${hours}時間${mins}分`;
}

// Get full image URL from relative path
export function getImageUrl(path: string | null): string | null {
  if (!path) return null;
  // If already a full URL, return as-is
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  // Otherwise, prepend the API URL
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";
  return `${apiUrl}${path}`;
}
