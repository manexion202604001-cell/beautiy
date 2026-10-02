"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, Store, ChevronDown, Check, Bell, FileText, UserX, BookOpen, QrCode } from "lucide-react";
import { auth, notifications as notificationsApi, reservations, type Staff, type Notification } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { PrelinkQrDialog } from "@/components/prelink-qr-dialog";

type MobileHeaderProps = {
  staff: Staff;
};

export function MobileHeader({ staff }: MobileHeaderProps) {
  const router = useRouter();
  const { currentStore, stores, setCurrentStore } = useStore();
  const [prelinkQrOpen, setPrelinkQrOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [retiredCount, setRetiredCount] = useState(0);
  const [notifList, setNotifList] = useState<Notification[]>([]);

  useEffect(() => {
    const fetchUnread = () => {
      notificationsApi.unreadCount().then((r) => setUnread(r.count)).catch(() => {});
      reservations.retiredStaffCount().then((r) => setRetiredCount(r.count)).catch(() => {});
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    const onVisible = () => { if (document.visibilityState === "visible") fetchUnread(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  const openNotifications = async () => {
    try {
      const r = await notificationsApi.list();
      setNotifList(r.notifications);
    } catch { /* noop */ }
  };

  const handleNotifClick = async (n: Notification) => {
    if (!n.is_read) {
      notificationsApi.markRead(n.id).catch(() => {});
      setUnread((u) => Math.max(0, u - 1));
    }
    if (n.link_url) router.push(n.link_url);
  };

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      // Ignore logout errors
    }
    router.push("/login");
  };

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b bg-background px-4 md:hidden">
      {stores.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 focus:outline-none">
              <h1 className="text-lg font-bold text-primary truncate max-w-[200px]">{currentStore?.name || "SALOGIC Staff"}</h1>
              <ChevronDown className="h-4 w-4 text-primary shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>店舗切替</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {stores.map((store) => (
              <DropdownMenuItem
                key={store.id}
                onClick={() => setCurrentStore(store)}
                className="cursor-pointer"
              >
                <Store className="mr-2 h-4 w-4" />
                <span className="truncate">{store.name}</span>
                {currentStore?.id === store.id && (
                  <Check className="ml-auto h-4 w-4" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <h1 className="text-lg font-bold text-primary truncate max-w-[200px]">{currentStore?.name || "SALOGIC Staff"}</h1>
      )}
      <div className="flex items-center gap-2">
      <Link href="/manual" aria-label="マニュアル" className="focus:outline-none p-1">
        <BookOpen className="h-5 w-5 text-muted-foreground" />
      </Link>
      {retiredCount > 0 && (
        <Link href="/retired-reservations" aria-label="退職スタッフ担当の予約" className="relative focus:outline-none p-1">
          <UserX className="h-5 w-5 text-muted-foreground" />
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
            {retiredCount > 99 ? "99+" : retiredCount}
          </span>
        </Link>
      )}
      <DropdownMenu onOpenChange={(o) => o && openNotifications()}>
        <DropdownMenuTrigger asChild>
          <button className="relative focus:outline-none p-1">
            <Bell className="h-5 w-5 text-muted-foreground" />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 max-h-[70vh] overflow-y-auto">
          <DropdownMenuLabel className="flex items-center justify-between">
            <span>通知</span>
            {unread > 0 && (
              <button
                className="text-xs font-normal text-primary"
                onClick={() => { notificationsApi.markAllRead().catch(() => {}); setUnread(0); setNotifList((l) => l.map((n) => ({ ...n, is_read: 1 }))); }}
              >すべて既読</button>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {notifList.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">通知はありません</div>
          ) : (
            notifList.map((n) => (
              <DropdownMenuItem key={n.id} onClick={() => handleNotifClick(n)} className="flex flex-col items-start gap-0.5 cursor-pointer">
                <div className="flex items-center gap-1 w-full">
                  {!n.is_read && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />}
                  <span className="text-sm font-medium truncate">{n.title}</span>
                </div>
                {n.body && <span className="text-xs text-muted-foreground line-clamp-2">{n.body}</span>}
                <span className="text-[10px] text-muted-foreground">{n.created_at}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="focus:outline-none">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                {(staff.nickname || staff.name).charAt(0)}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">{staff.nickname || staff.name}</p>
              <p className="text-xs text-muted-foreground">{staff.email}</p>
              {staff.staff_code && (
                <p className="text-xs text-muted-foreground">ID: {staff.staff_code}</p>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/walkin-intakes")} className="cursor-pointer">
            <FileText className="mr-2 h-4 w-4" />
            同意書確認
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPrelinkQrOpen(true)} className="cursor-pointer">
            <QrCode className="mr-2 h-4 w-4" />
            事前連携QR
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout} className="text-destructive">
            <LogOut className="mr-2 h-4 w-4" />
            ログアウト
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
      {currentStore && (
        <PrelinkQrDialog
          open={prelinkQrOpen}
          onOpenChange={setPrelinkQrOpen}
          storeId={currentStore.id}
          storeName={currentStore.name}
        />
      )}
    </header>
  );
}
