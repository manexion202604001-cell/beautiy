"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Calendar,
  Users,
  MessageSquare,
  Home,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { type Staff, messages } from "@/lib/api";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const mainNavItems = [
  { name: "ホーム", href: "/dashboard", icon: Home },
  { name: "予約", href: "/reservations", icon: Calendar },
  { name: "顧客", href: "/karutes", icon: Users },
  { name: "メッセージ", href: "/messages", icon: MessageSquare },
];

const moreNavItems = [
  { name: "同意書一覧", href: "/walkin-intakes" },
  { name: "メニュー", href: "/menus", roles: ["system_admin", "owner", "manager"] },
  { name: "予約受付設定", href: "/reservation-settings", roles: ["system_admin", "owner", "manager"] },
  { name: "スタッフ", href: "/staff", roles: ["system_admin", "owner", "manager"] },
  { name: "店舗設定", href: "/store-settings", roles: ["system_admin", "owner", "manager"] },
  { name: "設定", href: "/settings", roles: ["system_admin", "owner"] },
];

type BottomNavProps = {
  staff: Staff;
};

export function BottomNav({ staff }: BottomNavProps) {
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const fetchUnread = () => {
      messages.unreadCount().then((r) => setUnreadCount(r.count)).catch(() => {});
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchUnread();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('messages-read', fetchUnread);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('messages-read', fetchUnread);
    };
  }, []);

  const filteredMoreItems = moreNavItems.filter(
    (item) => !item.roles || item.roles.includes(staff.role)
  );

  const isMoreActive = filteredMoreItems.some(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background md:hidden">
      <div className="flex h-16 items-center justify-around">
        {mainNavItems.map((item) => {
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
        {filteredMoreItems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "flex flex-col items-center gap-1 px-3 py-2",
                  isMoreActive ? "text-primary" : "text-muted-foreground"
                )}
              >
                <MoreHorizontal className="h-5 w-5" />
                <span className="text-[10px] font-medium">その他</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="mb-2">
              {filteredMoreItems.map((item) => (
                <DropdownMenuItem key={item.name} asChild>
                  <Link href={item.href}>{item.name}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </nav>
  );
}
