"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { staff as staffApi, type Staff, type StaffBusinessHours, type StaffReservationSettings } from "@/lib/api";

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
  is_closed: i === 0, // Sunday closed by default
}));

const DEFAULT_SETTINGS: SettingsForm = {
  advance_booking_days: 365,
  same_day_cutoff_hours: 1,
  max_concurrent: 1,
  accept_same_start_time: false,
  accept_outside_hours: false,
};

export function StaffSettingsDialog({
  open,
  onOpenChange,
  staffMember,
  storeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staffMember: Staff | null;
  storeId: string;
}) {
  const [hours, setHours] = useState<HoursForm>(DEFAULT_HOURS);
  const [settings, setSettings] = useState<SettingsForm>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [savingHours, setSavingHours] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [copying, setCopying] = useState(false);
  const [hoursConfigured, setHoursConfigured] = useState(false);

  useEffect(() => {
    if (!open || !staffMember) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const [hoursRes, settingsRes] = await Promise.all([
          staffApi.getBusinessHours(staffMember.id, storeId),
          staffApi.getReservationSettings(staffMember.id, storeId),
        ]);

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

        setSettings({
          advance_booking_days: settingsRes.settings.advance_booking_days,
          same_day_cutoff_hours: settingsRes.settings.same_day_cutoff_hours,
          max_concurrent: settingsRes.settings.max_concurrent,
          accept_same_start_time: !!settingsRes.settings.accept_same_start_time,
          accept_outside_hours: !!settingsRes.settings.accept_outside_hours,
        });
      } catch (error) {
        console.error("Failed to fetch staff settings:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [open, staffMember, storeId]);

  const handleCopyStoreHours = async () => {
    if (!staffMember) return;
    setCopying(true);
    try {
      const result = await staffApi.copyStoreHours(staffMember.id, storeId);
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
    } finally {
      setCopying(false);
    }
  };

  const handleSaveHours = async () => {
    if (!staffMember) return;
    setSavingHours(true);
    try {
      const result = await staffApi.updateBusinessHours(staffMember.id, storeId, hours);
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
    } finally {
      setSavingHours(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!staffMember) return;
    setSavingSettings(true);
    try {
      const result = await staffApi.updateReservationSettings(staffMember.id, storeId, {
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
    } finally {
      setSavingSettings(false);
    }
  };

  const updateHour = (dayIndex: number, field: keyof HoursForm[0], value: string | boolean) => {
    setHours((prev) =>
      prev.map((h) => (h.day_of_week === dayIndex ? { ...h, [field]: value } : h))
    );
  };

  if (!staffMember) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{staffMember.name} - 設定</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">読み込み中...</div>
        ) : (
          <Tabs defaultValue="hours" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="hours">営業時間</TabsTrigger>
              <TabsTrigger value="reservation">予約設定</TabsTrigger>
            </TabsList>

            {/* Business Hours Tab */}
            <TabsContent value="hours" className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {hoursConfigured ? "個別設定済み" : "未設定（サロンの営業時間を使用）"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyStoreHours}
                  disabled={copying}
                >
                  {copying ? "反映中..." : "サロンの営業時間を反映"}
                </Button>
              </div>

              <div className="space-y-2">
                {hours
                  .sort((a, b) => a.day_of_week - b.day_of_week)
                  .map((h) => (
                    <div
                      key={h.day_of_week}
                      className="flex items-center gap-2"
                    >
                      <span
                        className={`w-6 text-center text-sm font-medium ${
                          h.day_of_week === 0
                            ? "text-red-500"
                            : h.day_of_week === 6
                              ? "text-blue-500"
                              : ""
                        }`}
                      >
                        {DAY_LABELS[h.day_of_week]}
                      </span>
                      <Input
                        type="time"
                        value={h.open_time}
                        onChange={(e) => updateHour(h.day_of_week, "open_time", e.target.value)}
                        className="w-28 h-8 text-sm"
                        disabled={h.is_closed}
                      />
                      <span className="text-sm text-muted-foreground">~</span>
                      <Input
                        type="time"
                        value={h.close_time}
                        onChange={(e) => updateHour(h.day_of_week, "close_time", e.target.value)}
                        className="w-28 h-8 text-sm"
                        disabled={h.is_closed}
                      />
                      <div className="flex items-center gap-1">
                        <Checkbox
                          checked={h.is_closed}
                          onCheckedChange={(checked) =>
                            updateHour(h.day_of_week, "is_closed", !!checked)
                          }
                        />
                        <span className="text-xs text-muted-foreground">休み</span>
                      </div>
                    </div>
                  ))}
              </div>

              <Button
                onClick={handleSaveHours}
                disabled={savingHours}
                className="w-full"
              >
                {savingHours ? "保存中..." : "営業時間を保存"}
              </Button>
            </TabsContent>

            {/* Reservation Settings Tab */}
            <TabsContent value="reservation" className="space-y-4">
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-sm">何日先まで予約を受け付ける</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={730}
                      value={settings.advance_booking_days}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, advance_booking_days: parseInt(e.target.value) || 365 }))
                      }
                      className="w-24 h-8"
                    />
                    <span className="text-sm text-muted-foreground">日</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm">当日予約の締め切り</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      max={24}
                      value={settings.same_day_cutoff_hours}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, same_day_cutoff_hours: parseInt(e.target.value) || 0 }))
                      }
                      className="w-24 h-8"
                    />
                    <span className="text-sm text-muted-foreground">時間前（0 = 制限なし）</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm">同時刻に予約可能な人数</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={settings.max_concurrent}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, max_concurrent: parseInt(e.target.value) || 1 }))
                      }
                      className="w-24 h-8"
                    />
                    <span className="text-sm text-muted-foreground">人</span>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <Label className="text-sm">開始時刻が同じ予約を受付する</Label>
                  <Switch
                    checked={settings.accept_same_start_time}
                    onCheckedChange={(checked) =>
                      setSettings((s) => ({ ...s, accept_same_start_time: checked }))
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label className="text-sm">営業時間外の予約を受付する</Label>
                  <Switch
                    checked={settings.accept_outside_hours}
                    onCheckedChange={(checked) =>
                      setSettings((s) => ({ ...s, accept_outside_hours: checked }))
                    }
                  />
                </div>
              </div>

              <Button
                onClick={handleSaveSettings}
                disabled={savingSettings}
                className="w-full"
              >
                {savingSettings ? "保存中..." : "予約設定を保存"}
              </Button>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
