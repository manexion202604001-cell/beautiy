"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Calendar,
  Users,
  MessageSquare,
  Home,
  Scissors,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { messages, reservations } from "@/lib/api";
import { useEffect, useState } from "react";

const navItems = [
  { name: "ホーム", href: "/dashboard", icon: Home },
  { name: "予約", href: "/reservations", icon: Calendar },
  { name: "顧客", href: "/customers", icon: Users },
  { name: "メッセージ", href: "/messages", icon: MessageSquare },
  { name: "メニュー", href: "/menu-management", icon: Scissors },
  { name: "設定", href: "/settings", icon: Settings },
];

export function BottomNav() {
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const fetchUnread = () => {
      messages.unreadCount().then((r) => setUnreadCount(r.count)).catch(() => {});
    };
    const fetchPending = () => {
      reservations.pendingCount().then((r) => setPendingCount(r.count)).catch(() => {});
    };
    fetchUnread();
    fetchPending();
    const interval = setInterval(() => { fetchUnread(); fetchPending(); }, 30000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') { fetchUnread(); fetchPending(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('messages-read', fetchUnread);
    window.addEventListener('reservations-updated', fetchPending);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('messages-read', fetchUnread);
      window.removeEventListener('reservations-updated', fetchPending);
    };
  }, []);

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background md:hidden">
      <div className="flex h-16 items-center justify-around">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex flex-col items-center gap-1 px-3 py-2",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <span className="relative">
                <item.icon className="h-5 w-5" />
                {item.href === "/dashboard" && pendingCount > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
                {item.href === "/messages" && unreadCount > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium">{item.name}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
