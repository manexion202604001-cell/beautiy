"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { staffSettings, staffBlocks, stores as storesApi, type StaffBusinessHours, type StaffReservationSettings, type StaffBlock } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { ChevronLeft, ChevronRight, Clock, Plus, Trash2 } from "lucide-react";

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

type HoursForm = {
  day_of_week: number;
  open_time: string;
  close_time: string;
  is_closed: boolean;
}[];

type SettingsForm = {
  advance_booking_days: number;
  same_day_cutoff_hours: number;
  max_concurrent: number;
  accept_same_start_time: boolean;
  accept_outside_hours: boolean;
};

const DEFAULT_HOURS: HoursForm = Array.from({ length: 7 }, (_, i) => ({
  day_of_week: i,
  open_time: "09:00",
  close_time: "19:00",
  is_closed: i === 0,
}));

const DEFAULT_SETTINGS: SettingsForm = {
  advance_booking_days: 365,
  same_day_cutoff_hours: 1,
  max_concurrent: 1,
  accept_same_start_time: false,
  accept_outside_hours: false,
};

export default function ReservationSettingsPage() {
  const { staff, currentStore } = useStore();

  // Business hours state
  const [hours, setHours] = useState<HoursForm>(DEFAULT_HOURS);
  const [hoursConfigured, setHoursConfigured] = useState(false);
  const [savingHours, setSavingHours] = useState(false);
  const [copying, setCopying] = useState(false);

  // Reservation settings state
  const [settings, setSettings] = useState<SettingsForm>(DEFAULT_SETTINGS);
  const [storeDefaults, setStoreDefaults] = useState<SettingsForm>(DEFAULT_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);

  // Calendar holidays state
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [originalDates, setOriginalDates] = useState<Set<string>>(new Set());
  const [timeBlocks, setTimeBlocks] = useState<StaffBlock[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [savingHolidays, setSavingHolidays] = useState(false);
  const [holidaySaved, setHolidaySaved] = useState(false);

  // Personal schedule state
  const [personalBlocks, setPersonalBlocks] = useState<StaffBlock[]>([]);
  const [personalLoading, setPersonalLoading] = useState(false);
  const [personalLoaded, setPersonalLoaded] = useState(false);
  const [deletingBlockId, setDeletingBlockId] = useState<string | null>(null);
  const [showAddBlock, setShowAddBlock] = useState(false);
  const [newBlockDate, setNewBlockDate] = useState("");
  const [newBlockStartTime, setNewBlockStartTime] = useState("10:00");
  const [newBlockEndTime, setNewBlockEndTime] = useState("11:00");
  const [newBlockReason, setNewBlockReason] = useState("");
  const [addingBlock, setAddingBlock] = useState(false);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!staff || !currentStore) return;
    setLoading(true);

    Promise.all([
      staffSettings.getBusinessHours(staff.id, currentStore.id),
      staffSettings.getReservationSettings(staff.id, currentStore.id),
      storesApi.get(currentStore.id),
    ]).then(([hoursRes, settingsRes, storeRes]) => {
      // Business hours
      if (hoursRes.business_hours.length > 0) {
        setHoursConfigured(true);
        setHours(
          hoursRes.business_hours.map((h) => ({
            day_of_week: h.day_of_week,
            open_time: h.open_time || "09:00",
            close_time: h.close_time || "19:00",
            is_closed: !!h.is_closed,
          }))
        );
      } else {
        setHoursConfigured(false);
        setHours(DEFAULT_HOURS);
      }

      // Reservation settings
      setSettings({
        advance_booking_days: settingsRes.settings.advance_booking_days,
        same_day_cutoff_hours: settingsRes.settings.same_day_cutoff_hours,
        max_concurrent: settingsRes.settings.max_concurrent,
        accept_same_start_time: !!settingsRes.settings.accept_same_start_time,
        accept_outside_hours: !!settingsRes.settings.accept_outside_hours,
      });

      // Store defaults for reference
      const store = storeRes.store;
      setStoreDefaults({
        advance_booking_days: store.advance_booking_days ?? 365,
        same_day_cutoff_hours: store.same_day_cutoff_hours ?? 1,
        max_concurrent: store.max_concurrent ?? 1,
        accept_same_start_time: !!(store.accept_same_start_time),
        accept_outside_hours: !!(store.accept_outside_hours),
      });
    }).catch(console.error).finally(() => setLoading(false));
  }, [staff?.id, currentStore?.id]);

  const fetchCalendarBlocks = useCallback(async (month: Date) => {
    if (!staff || !currentStore) return;
    setCalendarLoading(true);
    try {
      const y = month.getFullYear();
      const m = String(month.getMonth() + 1).padStart(2, "0");
      const dateFrom = `${y}-${m}-01`;
      const lastDay = new Date(y, month.getMonth() + 1, 0).getDate();
      const dateTo = `${y}-${m}-${String(lastDay).padStart(2, "0")}`;
      const { blocks: list } = await staffBlocks.list({
        staff_id: staff.id,
        store_id: currentStore.id,
        date_from: dateFrom,
        date_to: dateTo,
      });
      const allDayDates = new Set(list.filter((b) => b.is_all_day).map((b) => b.date));
      setSelectedDates(new Set(allDayDates));
      setOriginalDates(new Set(allDayDates));
      setTimeBlocks(list.filter((b) => !b.is_all_day));
    } catch (error) {
      console.error("Failed to fetch calendar blocks:", error);
    } finally {
      setCalendarLoading(false);
    }
  }, [staff?.id, currentStore?.id]);

  const fetchPersonalBlocks = useCallback(async () => {
    if (!staff || !currentStore) return;
    setPersonalLoading(true);
    try {
      const today = new Date();
      const dateFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      // Fetch 6 months ahead
      const future = new Date(today.getFullYear(), today.getMonth() + 6, today.getDate());
      const dateTo = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
      const { blocks } = await staffBlocks.list({
        staff_id: staff.id,
        store_id: currentStore.id,
        date_from: dateFrom,
        date_to: dateTo,
      });
      // Filter to time blocks only (not all-day holidays)
      setPersonalBlocks(blocks.filter((b) => !b.is_all_day).sort((a, b) => {
        const dateCompare = a.date.localeCompare(b.date);
        if (dateCompare !== 0) return dateCompare;
        return (a.start_time || "").localeCompare(b.start_time || "");
      }));
      setPersonalLoaded(true);
    } catch (error) {
      console.error("Failed to fetch personal blocks:", error);
    } finally {
      setPersonalLoading(false);
    }
  }, [staff?.id, currentStore?.id]);

  const handleDeleteBlock = async (blockId: string) => {
    setDeletingBlockId(blockId);
    try {
      await staffBlocks.delete(blockId);
      setPersonalBlocks((prev) => prev.filter((b) => b.id !== blockId));
    } catch (error) {
      console.error("Failed to delete block:", error);
      alert("削除に失敗しました");
    } finally {
      setDeletingBlockId(null);
    }
  };

  const handleAddBlock = async () => {
    if (!staff || !currentStore || !newBlockDate) return;
    setAddingBlock(true);
    try {
      await staffBlocks.create({
        store_id: currentStore.id,
        date: newBlockDate,
        is_all_day: false,
        start_time: newBlockStartTime,
        end_time: newBlockEndTime,
        reason: newBlockReason || undefined,
      });
      setShowAddBlock(false);
      setNewBlockDate("");
      setNewBlockStartTime("10:00");
      setNewBlockEndTime("11:00");
      setNewBlockReason("");
      await fetchPersonalBlocks();
    } catch (error) {
      console.error("Failed to create block:", error);
      alert("追加に失敗しました");
    } finally {
      setAddingBlock(false);
    }
  };

  const handleCopyStoreHours = async () => {
    if (!staff || !currentStore) return;
    setCopying(true);
    try {
      const result = await staffSettings.copyStoreHours(staff.id, currentStore.id);
      setHours(
        result.business_hours.map((h) => ({
          day_of_week: h.day_of_week,
          open_time: h.open_time || "09:00",
          close_time: h.close_time || "19:00",
          is_closed: !!h.is_closed,
        }))
      );
      setHoursConfigured(true);
    } catch (error) {
      console.error("Failed to copy store hours:", error);
      alert(error instanceof Error ? error.message : "サロンの営業時間の反映に失敗しました");
    } finally {
      setCopying(false);
    }
  };

  const handleSaveHours = async () => {
    if (!staff || !currentStore) return;
    setSavingHours(true);
    try {
      const result = await staffSettings.updateBusinessHours(staff.id, currentStore.id, hours);
      setHours(
        result.business_hours.map((h) => ({
          day_of_week: h.day_of_week,
          open_time: h.open_time || "09:00",
          close_time: h.close_time || "19:00",
          is_closed: !!h.is_closed,
        }))
      );
      setHoursConfigured(true);
    } catch (error) {
      console.error("Failed to save hours:", error);
      alert("営業時間の保存に失敗しました");
    } finally {
      setSavingHours(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!staff || !currentStore) return;
    setSavingSettings(true);
    try {
      const result = await staffSettings.updateReservationSettings(staff.id, currentStore.id, {
        advance_booking_days: settings.advance_booking_days,
        same_day_cutoff_hours: settings.same_day_cutoff_hours,
        max_concurrent: settings.max_concurrent,
        accept_same_start_time: settings.accept_same_start_time ? 1 : 0,
        accept_outside_hours: settings.accept_outside_hours ? 1 : 0,
      });
      setSettings({
        advance_booking_days: result.settings.advance_booking_days,
        same_day_cutoff_hours: result.settings.same_day_cutoff_hours,
        max_concurrent: result.settings.max_concurrent,
        accept_same_start_time: !!result.settings.accept_same_start_time,
        accept_outside_hours: !!result.settings.accept_outside_hours,
      });
    } catch (error) {
      console.error("Failed to save settings:", error);
      alert("予約設定の保存に失敗しました");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveHolidays = async () => {
    if (!staff || !currentStore) return;
    setSavingHolidays(true);
    setHolidaySaved(false);
    try {
      const y = calendarMonth.getFullYear();
      const m = String(calendarMonth.getMonth() + 1).padStart(2, "0");
      const { blocks: result } = await staffBlocks.sync({
        staff_id: staff.id,
        store_id: currentStore.id,
        month: `${y}-${m}`,
        dates: Array.from(selectedDates),
      });
      const allDayDates = new Set(result.filter((b) => b.is_all_day).map((b) => b.date));
      setSelectedDates(new Set(allDayDates));
      setOriginalDates(new Set(allDayDates));
      setTimeBlocks(result.filter((b) => !b.is_all_day));
      setHolidaySaved(true);
      setTimeout(() => setHolidaySaved(false), 2000);
    } catch (error) {
      console.error("Failed to save holidays:", error);
      alert("休日の保存に失敗しました");
    } finally {
      setSavingHolidays(false);
    }
  };

  const toggleDate = (dateStr: string) => {
    setSelectedDates((prev) => {
      const next = new Set(prev);
      if (next.has(dateStr)) {
        next.delete(dateStr);
      } else {
        next.add(dateStr);
      }
      return next;
    });
  };

  const hasChanges = (() => {
    if (selectedDates.size !== originalDates.size) return true;
    for (const d of selectedDates) {
      if (!originalDates.has(d)) return true;
    }
    return false;
  })();

  const updateHour = (dayIndex: number, field: string, value: string | boolean) => {
    setHours((prev) =>
      prev.map((h) => (h.day_of_week === dayIndex ? { ...h, [field]: value } : h))
    );
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">予約受付設定</h1>

      <Tabs defaultValue="hours">
        <TabsList className="flex w-full flex-wrap h-auto gap-1">
          <TabsTrigger value="hours">営業時間</TabsTrigger>
          <TabsTrigger value="settings">予約設定</TabsTrigger>
          <TabsTrigger value="personal" onClick={() => { if (!personalLoaded && !personalLoading) fetchPersonalBlocks(); }}>個人予定</TabsTrigger>
          <TabsTrigger value="holidays" onClick={() => { if (originalDates.size === 0 && !calendarLoading) fetchCalendarBlocks(calendarMonth); }}>個人休日</TabsTrigger>
        </TabsList>

        {/* Business Hours Tab */}
        <TabsContent value="hours" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>営業時間</CardTitle>
              <CardDescription>
                {hoursConfigured ? "個別設定済み" : "未設定（サロンの営業時間を使用中）"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyStoreHours}
                disabled={copying}
              >
                {copying ? "反映中..." : "サロンの営業時間を反映"}
              </Button>

              {!storeDefaults.accept_outside_hours && (
                <p className="text-xs text-muted-foreground">
                  サロンの「営業時間外の予約を受付する」が無効のため、時間の変更はできません。休みの設定のみ可能です。
                </p>
              )}

              <div className="space-y-2">
                {hours
                  .sort((a, b) => a.day_of_week - b.day_of_week)
                  .map((h) => (
                    <div key={h.day_of_week} className="flex items-center gap-2">
                      <span className={`w-6 text-center text-sm font-medium ${h.day_of_week === 0 ? "text-red-500" : h.day_of_week === 6 ? "text-blue-500" : ""}`}>
                        {DAY_LABELS[h.day_of_week]}
                      </span>
                      <Input
                        type="time"
                        value={h.open_time}
                        onChange={(e) => updateHour(h.day_of_week, "open_time", e.target.value)}
                        className="w-28 h-8 text-sm"
                        disabled={h.is_closed || !storeDefaults.accept_outside_hours}
                      />
                      <span className="text-sm text-muted-foreground">~</span>
                      <Input
                        type="time"
                        value={h.close_time}
                        onChange={(e) => updateHour(h.day_of_week, "close_time", e.target.value)}
                        className="w-28 h-8 text-sm"
                        disabled={h.is_closed || !storeDefaults.accept_outside_hours}
                      />
                      <div className="flex items-center gap-1">
                        <Checkbox
                          checked={h.is_closed}
                          onCheckedChange={(checked) => updateHour(h.day_of_week, "is_closed", !!checked)}
                        />
                        <span className="text-xs text-muted-foreground">休み</span>
                      </div>
                    </div>
                  ))}
              </div>

              <Button onClick={handleSaveHours} disabled={savingHours}>
                {savingHours ? "保存中..." : "保存"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Reservation Settings Tab */}
        <TabsContent value="settings" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>予約設定</CardTitle>
              <CardDescription>個別設定を保存するとサロンの設定より優先されます</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>何日先まで予約を受け付ける</Label>
                <div className="flex items-center gap-2">
                  <Select
                    value={String(settings.advance_booking_days)}
                    onValueChange={(v) => setSettings((s) => ({ ...s, advance_booking_days: parseInt(v) }))}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">7日</SelectItem>
                      <SelectItem value="14">14日</SelectItem>
                      <SelectItem value="30">30日</SelectItem>
                      <SelectItem value="60">60日</SelectItem>
                      <SelectItem value="90">90日</SelectItem>
                      <SelectItem value="180">180日</SelectItem>
                      <SelectItem value="365">365日</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">（サロン設定: {storeDefaults.advance_booking_days}日）</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>当日予約の締め切り</Label>
                <div className="flex items-center gap-2">
                  <Select
                    value={String(settings.same_day_cutoff_hours)}
                    onValueChange={(v) => setSettings((s) => ({ ...s, same_day_cutoff_hours: parseInt(v) }))}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">直前まで</SelectItem>
                      <SelectItem value="1">1時間前</SelectItem>
                      <SelectItem value="2">2時間前</SelectItem>
                      <SelectItem value="3">3時間前</SelectItem>
                      <SelectItem value="6">6時間前</SelectItem>
                      <SelectItem value="12">12時間前</SelectItem>
                      <SelectItem value="24">24時間前</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">（サロン設定: {storeDefaults.same_day_cutoff_hours === 0 ? '直前まで' : `${storeDefaults.same_day_cutoff_hours}時間前`}）</span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className={!storeDefaults.accept_same_start_time ? "text-muted-foreground" : ""}>開始時刻が同じ予約を受付する</Label>
                  <p className="text-xs text-muted-foreground">
                    {storeDefaults.accept_same_start_time
                      ? "サロン設定: はい"
                      : "サロン設定が「いいえ」のため変更できません"}
                  </p>
                </div>
                <Switch
                  checked={storeDefaults.accept_same_start_time ? settings.accept_same_start_time : false}
                  onCheckedChange={(checked) => setSettings((s) => ({ ...s, accept_same_start_time: checked }))}
                  disabled={!storeDefaults.accept_same_start_time}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className={!storeDefaults.accept_outside_hours ? "text-muted-foreground" : ""}>営業時間外の予約を受付する</Label>
                  <p className="text-xs text-muted-foreground">
                    {storeDefaults.accept_outside_hours
                      ? "サロン設定: はい"
                      : "サロン設定が「いいえ」のため変更できません"}
                  </p>
                </div>
                <Switch
                  checked={storeDefaults.accept_outside_hours ? settings.accept_outside_hours : false}
                  onCheckedChange={(checked) => setSettings((s) => ({ ...s, accept_outside_hours: checked }))}
                  disabled={!storeDefaults.accept_outside_hours}
                />
              </div>

              <Separator />
              <Button onClick={handleSaveSettings} disabled={savingSettings}>
                {savingSettings ? "保存中..." : "保存"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Personal Schedule Tab */}
        <TabsContent value="personal" className="mt-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>個人予定</CardTitle>
                <CardDescription className="mt-1.5">今日以降の個人予定の一覧です</CardDescription>
              </div>
              <Button size="sm" onClick={() => setShowAddBlock(true)}>
                <Plus className="h-4 w-4 mr-1" />
                追加
              </Button>
            </CardHeader>
            <CardContent>
              {personalLoading ? (
                <div className="py-12 text-center text-muted-foreground">読み込み中...</div>
              ) : personalBlocks.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">個人予定はありません</div>
              ) : (
                <div className="space-y-2">
                  {personalBlocks.map((block) => {
                    const d = new Date(block.date + "T00:00:00");
                    const dow = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
                    const dateLabel = `${d.getMonth() + 1}/${d.getDate()}(${dow})`;
                    return (
                      <div key={block.id} className="flex items-center justify-between p-3 rounded-lg border">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{dateLabel}</span>
                            <span className="text-sm text-muted-foreground">
                              {block.start_time?.slice(0, 5)} - {block.end_time?.slice(0, 5)}
                            </span>
                          </div>
                          {block.reason && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{block.reason}</p>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                          disabled={deletingBlockId === block.id}
                          onClick={() => handleDeleteBlock(block.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Dialog open={showAddBlock} onOpenChange={setShowAddBlock}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>個人予定を追加</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div>
                  <Label>日付</Label>
                  <Input
                    type="date"
                    value={newBlockDate}
                    onChange={(e) => setNewBlockDate(e.target.value)}
                    min={new Date().toISOString().slice(0, 10)}
                    className="mt-1"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>開始時間</Label>
                    <Input
                      type="time"
                      value={newBlockStartTime}
                      onChange={(e) => setNewBlockStartTime(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>終了時間</Label>
                    <Input
                      type="time"
                      value={newBlockEndTime}
                      onChange={(e) => setNewBlockEndTime(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                </div>
                <div>
                  <Label>理由（任意）</Label>
                  <Input
                    value={newBlockReason}
                    onChange={(e) => setNewBlockReason(e.target.value)}
                    placeholder="例: 研修、私用など"
                    className="mt-1"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button onClick={handleAddBlock} disabled={addingBlock || !newBlockDate}>
                  {addingBlock ? "追加中..." : "追加"}
                </Button>
                <Button variant="outline" onClick={() => setShowAddBlock(false)}>キャンセル</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* Personal Holidays Tab */}
        <TabsContent value="holidays" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>休日の設定</CardTitle>
              <CardDescription>カレンダーの日付をタップして休日を設定します</CardDescription>
            </CardHeader>
            <CardContent>
              {calendarLoading ? (
                <div className="py-12 text-center text-muted-foreground">読み込み中...</div>
              ) : (
                <div className="space-y-4">
                  {/* Month navigation */}
                  <div className="flex items-center justify-between">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const prev = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
                        setCalendarMonth(prev);
                        fetchCalendarBlocks(prev);
                      }}
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </Button>
                    <span className="text-lg font-semibold text-primary">
                      {calendarMonth.getFullYear()}年 {calendarMonth.getMonth() + 1}月
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const next = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
                        setCalendarMonth(next);
                        fetchCalendarBlocks(next);
                      }}
                    >
                      <ChevronRight className="h-5 w-5" />
                    </Button>
                  </div>

                  {/* Day headers (Mon-Sun) */}
                  <div className="grid grid-cols-7 text-center">
                    {["月", "火", "水", "木", "金", "土", "日"].map((d, i) => (
                      <div key={d} className={`py-2 text-sm font-medium ${i === 5 ? "text-blue-500" : i === 6 ? "text-red-500" : "text-muted-foreground"}`}>
                        {d}
                      </div>
                    ))}
                  </div>

                  {/* Calendar grid */}
                  <div className="grid grid-cols-7">
                    {(() => {
                      const year = calendarMonth.getFullYear();
                      const month = calendarMonth.getMonth();
                      const firstDay = new Date(year, month, 1);
                      // Monday = 0, Sunday = 6
                      let startOffset = firstDay.getDay() - 1;
                      if (startOffset < 0) startOffset = 6;
                      const daysInMonth = new Date(year, month + 1, 0).getDate();
                      const today = new Date();
                      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

                      const cells: React.ReactNode[] = [];

                      // Empty cells for offset
                      for (let i = 0; i < startOffset; i++) {
                        cells.push(<div key={`empty-${i}`} className="aspect-square" />);
                      }

                      for (let day = 1; day <= daysInMonth; day++) {
                        const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                        const isSelected = selectedDates.has(dateStr);
                        const isToday = dateStr === todayStr;
                        const isPast = dateStr < todayStr;
                        const hasTimeBlock = timeBlocks.some((b) => b.date === dateStr);
                        const dayOfWeek = new Date(year, month, day).getDay();
                        const isSaturday = dayOfWeek === 6;
                        const isSunday = dayOfWeek === 0;

                        cells.push(
                          <button
                            key={dateStr}
                            type="button"
                            disabled={isPast}
                            onClick={() => toggleDate(dateStr)}
                            className={`aspect-square flex items-center justify-center relative text-sm rounded-full transition-colors
                              ${isSelected
                                ? "bg-gray-400 text-white font-medium"
                                : isPast
                                  ? "text-gray-300 cursor-default"
                                  : isToday
                                    ? "text-emerald-600 font-bold"
                                    : isSunday
                                      ? "text-red-500"
                                      : isSaturday
                                        ? "text-blue-500"
                                        : "text-foreground hover:bg-muted"
                              }`}
                          >
                            {day}
                            {hasTimeBlock && !isSelected && (
                              <Clock className="absolute bottom-0.5 h-2.5 w-2.5 text-orange-400" />
                            )}
                          </button>
                        );
                      }

                      return cells;
                    })()}
                  </div>

                  {/* Today link */}
                  <div className="text-right">
                    <button
                      type="button"
                      className="text-sm text-primary hover:underline"
                      onClick={() => {
                        const now = new Date();
                        const newMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                        setCalendarMonth(newMonth);
                        fetchCalendarBlocks(newMonth);
                      }}
                    >
                      Today
                    </button>
                  </div>

                  <Separator />

                  {/* Save button */}
                  <Button
                    onClick={handleSaveHolidays}
                    disabled={savingHolidays || !hasChanges}
                    className="w-full"
                  >
                    {savingHolidays ? "保存中..." : holidaySaved ? "保存しました" : "保存"}
                  </Button>

                  {selectedDates.size > 0 && (
                    <p className="text-center text-xs text-muted-foreground">
                      {selectedDates.size}日の休日が選択されています
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
