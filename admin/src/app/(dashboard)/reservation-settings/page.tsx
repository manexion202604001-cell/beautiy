"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2 } from "lucide-react";
import { stores, staff as staffApi, type Store, type BusinessHours, type Staff, type StaffBusinessHours, type StaffReservationSettings, type StoreClosure } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { StaffSettingsDialog } from "../staff/staff-settings-dialog";

const DAYS = ["日", "月", "火", "水", "木", "金", "土"];

type SettingsForm = {
  advance_booking_days: number;
  advance_booking_months: number;
  same_day_cutoff_hours: number;
  max_concurrent: number;
  accept_same_start_time: boolean;
  accept_outside_hours: boolean;
  booking_cutoff_type: "same_day" | "days_before";
  booking_cutoff_days_before: number;
  booking_cutoff_time: string;
  booking_cutoff_same_day_minutes: number;
  booking_calc_method: "calendar" | "business_days";
  holiday_hours_enabled: boolean;
};

const DEFAULT_SETTINGS: SettingsForm = {
  advance_booking_days: 365,
  advance_booking_months: 4,
  same_day_cutoff_hours: 1,
  max_concurrent: 1,
  accept_same_start_time: false,
  accept_outside_hours: false,
  booking_cutoff_type: "same_day",
  booking_cutoff_days_before: 1,
  booking_cutoff_time: "24:00",
  booking_cutoff_same_day_minutes: 60,
  booking_calc_method: "calendar",
  holiday_hours_enabled: false,
};

export default function ReservationSettingsPage() {
  const { currentStore } = useStore();
  const [store, setStore] = useState<Store | null>(null);
  const [businessHours, setBusinessHours] = useState<BusinessHours[]>([]);
  const [settings, setSettings] = useState<SettingsForm>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [savingHours, setSavingHours] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Per-day capacity state
  const [savingCapacity, setSavingCapacity] = useState(false);

  // Store closures state
  const [closures, setClosures] = useState<StoreClosure[]>([]);
  const [newClosureDate, setNewClosureDate] = useState("");
  const [newClosureReason, setNewClosureReason] = useState("");
  const [addingClosure, setAddingClosure] = useState(false);

  // Staff tab state
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffHoursMap, setStaffHoursMap] = useState<Map<string, boolean>>(new Map());
  const [staffSettingsMap, setStaffSettingsMap] = useState<Map<string, boolean>>(new Map());
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<Staff | null>(null);

  useEffect(() => {
    if (!currentStore) return;
    setLoading(true);
    Promise.all([
      stores.get(currentStore.id),
      stores.getClosures(currentStore.id, new Date().toISOString().slice(0, 10)),
    ]).then(([{ store: s, business_hours: bh }, { closures: cl }]) => {
      setStore(s);
      setBusinessHours(bh);
      setClosures(cl);
      setSettings({
        advance_booking_days: s.advance_booking_days ?? 365,
        advance_booking_months: s.advance_booking_months ?? 4,
        same_day_cutoff_hours: s.same_day_cutoff_hours ?? 1,
        max_concurrent: s.max_concurrent ?? 1,
        accept_same_start_time: !!(s.accept_same_start_time),
        accept_outside_hours: !!(s.accept_outside_hours),
        booking_cutoff_type: (s.booking_cutoff_type as "same_day" | "days_before") || "same_day",
        booking_cutoff_days_before: s.booking_cutoff_days_before ?? 1,
        booking_cutoff_time: s.booking_cutoff_time || "24:00",
        booking_cutoff_same_day_minutes: s.booking_cutoff_same_day_minutes ?? 60,
        booking_calc_method: (s.booking_calc_method as "calendar" | "business_days") || "calendar",
        holiday_hours_enabled: !!(s.holiday_hours_enabled),
      });
    }).catch(console.error).finally(() => setLoading(false));
  }, [currentStore?.id]);

  const handleSaveHours = async () => {
    if (!store) return;
    setSavingHours(true);
    try {
      const { business_hours: updated } = await stores.updateHours(
        store.id,
        businessHours.map((h) => ({
          day_of_week: h.day_of_week,
          open_time: h.open_time,
          close_time: h.close_time,
          is_closed: h.is_closed === 1,
          max_concurrent: h.max_concurrent ?? null,
        }))
      );
      setBusinessHours(updated);
    } catch (error) {
      console.error("Failed to save hours:", error);
      alert(error instanceof Error ? error.message : "営業時間の保存に失敗しました");
    } finally {
      setSavingHours(false);
    }
  };

  const handleSaveCapacity = async () => {
    if (!store) return;
    setSavingCapacity(true);
    try {
      const { business_hours: updated } = await stores.updateHours(
        store.id,
        businessHours.map((h) => ({
          day_of_week: h.day_of_week,
          open_time: h.open_time,
          close_time: h.close_time,
          is_closed: h.is_closed === 1,
          max_concurrent: h.max_concurrent ?? null,
        }))
      );
      setBusinessHours(updated);
    } catch (error) {
      console.error("Failed to save capacity:", error);
      alert(error instanceof Error ? error.message : "受付可能数の保存に失敗しました");
    } finally {
      setSavingCapacity(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!store) return;
    setSavingSettings(true);
    try {
      const { settings: updated } = await stores.updateReservationSettings(store.id, {
        advance_booking_days: settings.advance_booking_days,
        advance_booking_months: settings.advance_booking_months,
        same_day_cutoff_hours: settings.booking_cutoff_type === "same_day" ? Math.floor(settings.booking_cutoff_same_day_minutes / 60) : settings.same_day_cutoff_hours,
        max_concurrent: settings.max_concurrent,
        accept_same_start_time: settings.accept_same_start_time,
        accept_outside_hours: settings.accept_outside_hours,
        booking_cutoff_type: settings.booking_cutoff_type,
        booking_cutoff_days_before: settings.booking_cutoff_days_before,
        booking_cutoff_time: settings.booking_cutoff_time,
        booking_cutoff_same_day_minutes: settings.booking_cutoff_same_day_minutes,
        booking_calc_method: settings.booking_calc_method,
        holiday_hours_enabled: settings.holiday_hours_enabled,
      });
      setSettings({
        advance_booking_days: updated.advance_booking_days,
        advance_booking_months: updated.advance_booking_months ?? 4,
        same_day_cutoff_hours: updated.same_day_cutoff_hours,
        max_concurrent: updated.max_concurrent,
        accept_same_start_time: !!updated.accept_same_start_time,
        accept_outside_hours: !!updated.accept_outside_hours,
        booking_cutoff_type: (updated.booking_cutoff_type as "same_day" | "days_before") || "same_day",
        booking_cutoff_days_before: updated.booking_cutoff_days_before ?? 1,
        booking_cutoff_time: updated.booking_cutoff_time || "24:00",
        booking_cutoff_same_day_minutes: updated.booking_cutoff_same_day_minutes ?? 60,
        booking_calc_method: (updated.booking_calc_method as "calendar" | "business_days") || "calendar",
        holiday_hours_enabled: !!updated.holiday_hours_enabled,
      });
    } catch (error) {
      console.error("Failed to save settings:", error);
      alert(error instanceof Error ? error.message : "予約設定の保存に失敗しました");
    } finally {
      setSavingSettings(false);
    }
  };

  const fetchStaffData = async () => {
    if (!currentStore) return;
    setStaffLoading(true);
    try {
      const { staff: list } = await staffApi.list(currentStore.id);
      setStaffList(list);

      const hoursMap = new Map<string, boolean>();
      const settingsMap = new Map<string, boolean>();

      await Promise.all(
        list.map(async (s: Staff) => {
          try {
            const [hoursRes, settingsRes] = await Promise.all([
              staffApi.getBusinessHours(s.id, currentStore.id),
              staffApi.getReservationSettings(s.id, currentStore.id),
            ]);
            hoursMap.set(s.id, hoursRes.business_hours.length > 0);
            settingsMap.set(s.id, !!settingsRes.settings.staff_id);
          } catch {
            hoursMap.set(s.id, false);
            settingsMap.set(s.id, false);
          }
        })
      );

      setStaffHoursMap(hoursMap);
      setStaffSettingsMap(settingsMap);
    } catch (error) {
      console.error("Failed to fetch staff:", error);
    } finally {
      setStaffLoading(false);
    }
  };

  const fetchClosures = async () => {
    if (!currentStore) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { closures: list } = await stores.getClosures(currentStore.id, today);
      setClosures(list);
    } catch (error) {
      console.error("Failed to fetch closures:", error);
    }
  };

  const handleAddClosure = async () => {
    if (!store || !newClosureDate) return;
    setAddingClosure(true);
    try {
      await stores.addClosure(store.id, newClosureDate, newClosureReason || undefined);
      setNewClosureDate("");
      setNewClosureReason("");
      await fetchClosures();
    } catch (error) {
      console.error("Failed to add closure:", error);
      alert(error instanceof Error ? error.message : "臨時休業日の追加に失敗しました");
    } finally {
      setAddingClosure(false);
    }
  };

  const handleDeleteClosure = async (closureId: string) => {
    if (!store) return;
    try {
      await stores.deleteClosure(store.id, closureId);
      setClosures((prev) => prev.filter((c) => c.id !== closureId));
    } catch (error) {
      console.error("Failed to delete closure:", error);
      alert(error instanceof Error ? error.message : "削除に失敗しました");
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">店舗情報が見つかりません</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">予約受付設定</h1>

      <Tabs defaultValue="hours">
        <TabsList className="flex w-full flex-wrap h-auto gap-1">
          <TabsTrigger value="hours">営業時間・定休日</TabsTrigger>
          <TabsTrigger value="capacity">受付可能数</TabsTrigger>
          <TabsTrigger value="settings">予約設定</TabsTrigger>
          <TabsTrigger value="staff" onClick={() => { if (staffList.length === 0) fetchStaffData(); }}>スタッフ別設定</TabsTrigger>
        </TabsList>

        {/* Business Hours Tab */}
        <TabsContent value="hours" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>営業時間・定休日</CardTitle>
              <CardDescription>曜日ごとの営業時間と定休日を設定します。スタッフの個別設定がない場合、この設定が適用されます。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {businessHours.filter(h => h.day_of_week <= 6).map((hours, index) => (
                  <div key={hours.day_of_week} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <div className={`w-8 font-medium shrink-0 ${hours.day_of_week === 0 ? "text-red-500" : hours.day_of_week === 6 ? "text-blue-500" : ""}`}>
                      {DAYS[hours.day_of_week]}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="time"
                        value={hours.open_time || ""}
                        disabled={hours.is_closed === 1}
                        className="w-[7rem]"
                        onChange={(e) => {
                          const bhIndex = businessHours.findIndex(h => h.day_of_week === hours.day_of_week);
                          const updated = [...businessHours];
                          updated[bhIndex] = { ...hours, open_time: e.target.value };
                          setBusinessHours(updated);
                        }}
                      />
                      <span className="text-muted-foreground">〜</span>
                      <Input
                        type="time"
                        value={hours.close_time || ""}
                        disabled={hours.is_closed === 1}
                        className="w-[7rem]"
                        onChange={(e) => {
                          const bhIndex = businessHours.findIndex(h => h.day_of_week === hours.day_of_week);
                          const updated = [...businessHours];
                          updated[bhIndex] = { ...hours, close_time: e.target.value };
                          setBusinessHours(updated);
                        }}
                      />
                    </div>
                    <label className="flex items-center gap-1.5 shrink-0">
                      <input
                        type="checkbox"
                        checked={hours.is_closed === 1}
                        onChange={(e) => {
                          const bhIndex = businessHours.findIndex(h => h.day_of_week === hours.day_of_week);
                          const updated = [...businessHours];
                          updated[bhIndex] = { ...hours, is_closed: e.target.checked ? 1 : 0 };
                          setBusinessHours(updated);
                        }}
                      />
                      <span className="text-sm">休</span>
                    </label>
                  </div>
                ))}

                {/* Holiday hours row */}
                {settings.holiday_hours_enabled && (() => {
                  const holidayHours = businessHours.find(h => h.day_of_week === 7);
                  if (!holidayHours) return null;
                  return (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <div className="w-8 font-medium shrink-0 text-red-500">祝</div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="time"
                          value={holidayHours.open_time || ""}
                          disabled={holidayHours.is_closed === 1}
                          className="w-[7rem]"
                          onChange={(e) => {
                            const bhIndex = businessHours.findIndex(h => h.day_of_week === 7);
                            const updated = [...businessHours];
                            updated[bhIndex] = { ...holidayHours, open_time: e.target.value };
                            setBusinessHours(updated);
                          }}
                        />
                        <span className="text-muted-foreground">〜</span>
                        <Input
                          type="time"
                          value={holidayHours.close_time || ""}
                          disabled={holidayHours.is_closed === 1}
                          className="w-[7rem]"
                          onChange={(e) => {
                            const bhIndex = businessHours.findIndex(h => h.day_of_week === 7);
                            const updated = [...businessHours];
                            updated[bhIndex] = { ...holidayHours, close_time: e.target.value };
                            setBusinessHours(updated);
                          }}
                        />
                      </div>
                      <label className="flex items-center gap-1.5 shrink-0">
                        <input
                          type="checkbox"
                          checked={holidayHours.is_closed === 1}
                          onChange={(e) => {
                            const bhIndex = businessHours.findIndex(h => h.day_of_week === 7);
                            const updated = [...businessHours];
                            updated[bhIndex] = { ...holidayHours, is_closed: e.target.checked ? 1 : 0 };
                            setBusinessHours(updated);
                          }}
                        />
                        <span className="text-sm">休</span>
                      </label>
                    </div>
                  );
                })()}
              </div>

              <div className="mt-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={settings.holiday_hours_enabled}
                    onChange={(e) => {
                      setSettings((s) => ({ ...s, holiday_hours_enabled: e.target.checked }));
                      // Save holiday_hours_enabled via reservation-settings API
                      if (store) {
                        stores.updateReservationSettings(store.id, {
                          holiday_hours_enabled: e.target.checked,
                        }).catch(console.error);
                      }
                    }}
                  />
                  <span className="text-sm font-medium">祝日の営業時間を個別に設定する</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-5">
                  有効にすると、祝日は通常の曜日設定ではなく祝日の営業時間が適用されます
                </p>
              </div>

              <Separator className="my-6" />
              <Button onClick={handleSaveHours} disabled={savingHours}>
                {savingHours ? "保存中..." : "保存"}
              </Button>
            </CardContent>
          </Card>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>臨時休業日</CardTitle>
              <CardDescription>定休日以外の臨時休業日（年末年始、内装工事など）を設定します。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 mb-4">
                <Input
                  type="date"
                  value={newClosureDate}
                  onChange={(e) => setNewClosureDate(e.target.value)}
                  min={new Date().toISOString().slice(0, 10)}
                  className="w-44"
                />
                <Input
                  type="text"
                  placeholder="理由（任意）"
                  value={newClosureReason}
                  onChange={(e) => setNewClosureReason(e.target.value)}
                  className="w-48"
                />
                <Button onClick={handleAddClosure} disabled={!newClosureDate || addingClosure}>
                  {addingClosure ? "追加中..." : "追加"}
                </Button>
              </div>
              {closures.length === 0 ? (
                <p className="text-sm text-muted-foreground">登録されている臨時休業日はありません</p>
              ) : (
                <div className="space-y-2">
                  {closures.map((closure) => (
                    <div key={closure.id} className="flex items-center justify-between rounded-lg border p-3">
                      <div>
                        <p className="font-medium">
                          {new Date(closure.date + "T00:00:00").toLocaleDateString("ja-JP", {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                            weekday: "short",
                          })}
                        </p>
                        {closure.reason && (
                          <p className="text-sm text-muted-foreground">{closure.reason}</p>
                        )}
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteClosure(closure.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Per-day Capacity Tab */}
        <TabsContent value="capacity" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>受付可能数設定</CardTitle>
              <CardDescription>曜日ごとの同時受付可能人数を設定します。未設定の場合は予約設定のデフォルト値が適用されます。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {businessHours.filter(h => h.day_of_week <= 6 || (h.day_of_week === 7 && settings.holiday_hours_enabled)).map((hours) => (
                  <div key={hours.day_of_week} className="flex items-center gap-4">
                    <div className={`w-12 font-medium ${hours.day_of_week === 0 || hours.day_of_week === 7 ? "text-red-500" : hours.day_of_week === 6 ? "text-blue-500" : ""}`}>
                      {hours.day_of_week === 7 ? "祝" : DAYS[hours.day_of_week]}
                    </div>
                    {hours.is_closed === 1 ? (
                      <span className="text-sm text-muted-foreground">定休日</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={20}
                          value={hours.max_concurrent ?? settings.max_concurrent}
                          onChange={(e) => {
                            const bhIndex = businessHours.findIndex(h => h.day_of_week === hours.day_of_week);
                            const updated = [...businessHours];
                            updated[bhIndex] = { ...hours, max_concurrent: parseInt(e.target.value) || 1 };
                            setBusinessHours(updated);
                          }}
                          className="w-20"
                        />
                        <span className="text-sm text-muted-foreground">人</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <Separator className="my-6" />
              <Button onClick={handleSaveCapacity} disabled={savingCapacity}>
                {savingCapacity ? "保存中..." : "保存"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Reservation Settings Tab */}
        <TabsContent value="settings" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>予約設定</CardTitle>
              <CardDescription>サロン全体の予約ルールを設定します。スタッフの個別設定がない場合、この設定が適用されます。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* 受付開始 */}
              <div className="space-y-2">
                <Label>受付開始</Label>
                <p className="text-sm text-muted-foreground">何ヶ月先まで予約を受け付けるか（当月＋Nヶ月の末日まで）</p>
                <div className="flex items-center gap-2">
                  <Select
                    value={String(settings.advance_booking_months)}
                    onValueChange={(v) => setSettings((s) => ({ ...s, advance_booking_months: parseInt(v) }))}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => (
                        <SelectItem key={m} value={String(m)}>{m}ヶ月先まで</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              {/* 受付締切 */}
              <div className="space-y-4">
                <div>
                  <Label>受付締切</Label>
                  <p className="text-sm text-muted-foreground">予約の受付をいつまで可能にするか</p>
                </div>

                {/* Option A: 当日まで */}
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    className="mt-1"
                    checked={settings.booking_cutoff_type === "same_day"}
                    onChange={() => setSettings((s) => ({ ...s, booking_cutoff_type: "same_day" }))}
                  />
                  <div className="space-y-2">
                    <span className="text-sm font-medium">当日まで受付をする</span>
                    {settings.booking_cutoff_type === "same_day" && (
                      <Select
                        value={String(settings.booking_cutoff_same_day_minutes)}
                        onValueChange={(v) => setSettings((s) => ({ ...s, booking_cutoff_same_day_minutes: parseInt(v) }))}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">直前まで</SelectItem>
                          <SelectItem value="30">30分前まで</SelectItem>
                          <SelectItem value="60">1時間前まで</SelectItem>
                          <SelectItem value="120">2時間前まで</SelectItem>
                          <SelectItem value="180">3時間前まで</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </label>

                {/* Option B: 前日以前に締切 */}
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    className="mt-1"
                    checked={settings.booking_cutoff_type === "days_before"}
                    onChange={() => setSettings((s) => ({ ...s, booking_cutoff_type: "days_before" }))}
                  />
                  <div className="space-y-2">
                    <span className="text-sm font-medium">前日以前に締め切る</span>
                    {settings.booking_cutoff_type === "days_before" && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={String(settings.booking_cutoff_days_before)}
                          onValueChange={(v) => setSettings((s) => ({ ...s, booking_cutoff_days_before: parseInt(v) }))}
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">1日前</SelectItem>
                            <SelectItem value="2">2日前</SelectItem>
                            <SelectItem value="3">3日前</SelectItem>
                            <SelectItem value="5">5日前</SelectItem>
                            <SelectItem value="7">7日前</SelectItem>
                          </SelectContent>
                        </Select>
                        <span className="text-sm text-muted-foreground">の</span>
                        <Select
                          value={settings.booking_cutoff_time}
                          onValueChange={(v) => setSettings((s) => ({ ...s, booking_cutoff_time: v }))}
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="24:00">24時まで</SelectItem>
                            <SelectItem value="21:00">21時まで</SelectItem>
                            <SelectItem value="18:00">18時まで</SelectItem>
                            <SelectItem value="15:00">15時まで</SelectItem>
                            <SelectItem value="12:00">12時まで</SelectItem>
                            <SelectItem value="09:00">9時まで</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </label>
              </div>

              <Separator />

              {/* 計算方法 */}
              <div className="space-y-2">
                <Label>受付期間の計算方法</Label>
                <p className="text-sm text-muted-foreground">受付開始・受付締切の日数カウント方法</p>
                <Select
                  value={settings.booking_calc_method}
                  onValueChange={(v) => setSettings((s) => ({ ...s, booking_calc_method: v as "calendar" | "business_days" }))}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="calendar">日数で計算</SelectItem>
                    <SelectItem value="business_days">営業日で計算（休業日を除く）</SelectItem>
                  </SelectContent>
                </Select>
                {settings.booking_calc_method === "business_days" && (
                  <p className="text-xs text-muted-foreground">定休日と臨時休業日を除いた営業日数でカウントします</p>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>デフォルト受付可能数</Label>
                <p className="text-sm text-muted-foreground">曜日別の受付可能数が未設定の場合に適用されるデフォルト値</p>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={settings.max_concurrent}
                    onChange={(e) => setSettings((s) => ({ ...s, max_concurrent: parseInt(e.target.value) || 1 }))}
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">人</span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label>開始時刻が同じ予約を受付する</Label>
                  <p className="text-sm text-muted-foreground">同じ時間帯に複数の予約を受け付けます</p>
                </div>
                <Switch
                  checked={settings.accept_same_start_time}
                  onCheckedChange={(checked) => setSettings((s) => ({ ...s, accept_same_start_time: checked }))}
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label>営業時間外の予約を受付する</Label>
                  <p className="text-sm text-muted-foreground">営業時間外でも予約を受け付けます</p>
                </div>
                <Switch
                  checked={settings.accept_outside_hours}
                  onCheckedChange={(checked) => setSettings((s) => ({ ...s, accept_outside_hours: checked }))}
                />
              </div>

              <Separator />
              <Button onClick={handleSaveSettings} disabled={savingSettings}>
                {savingSettings ? "保存中..." : "保存"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Staff Settings Tab */}
        <TabsContent value="staff" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>スタッフ別設定</CardTitle>
              <CardDescription>スタッフごとの個別設定を管理します。未設定の場合はサロンの設定が適用されます。</CardDescription>
            </CardHeader>
            <CardContent>
              {staffLoading ? (
                <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
              ) : staffList.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">スタッフが登録されていません</div>
              ) : (
                <div className="space-y-2">
                  {staffList.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between rounded-lg border p-3 cursor-pointer hover:bg-accent"
                      onClick={() => { setSelectedStaff(s); setSettingsDialogOpen(true); }}
                    >
                      <div>
                        <p className="font-medium">{s.name}</p>
                        <div className="flex gap-3 mt-1">
                          <span className={`text-xs ${staffHoursMap.get(s.id) ? "text-primary" : "text-muted-foreground"}`}>
                            営業時間: {staffHoursMap.get(s.id) ? "個別設定あり" : "サロン設定"}
                          </span>
                          <span className={`text-xs ${staffSettingsMap.get(s.id) ? "text-primary" : "text-muted-foreground"}`}>
                            予約設定: {staffSettingsMap.get(s.id) ? "個別設定あり" : "サロン設定"}
                          </span>
                        </div>
                      </div>
                      <span className="text-muted-foreground text-sm">編集 →</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <StaffSettingsDialog
        open={settingsDialogOpen}
        onOpenChange={(open) => {
          setSettingsDialogOpen(open);
          if (!open) fetchStaffData();
        }}
        staffMember={selectedStaff}
        storeId={currentStore?.id || ""}
      />

    </div>
  );
}
