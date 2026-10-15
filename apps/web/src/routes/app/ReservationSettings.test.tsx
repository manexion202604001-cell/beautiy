import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orgApi } from '../../api/org';
import { schedulesApi } from '../../api/schedules';
import { staffScreenApi } from '../../api/staffScreen';
import type { BusinessHour, CalendarException, Shop, ShopSettings, Staff } from '../../api/types';
import { ToastProvider } from '../../components/ui';
import { addDays, todayIn } from '../../lib/time';
import ReservationSettings from './ReservationSettings';

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: () => true, currentShopId: 'shop-1', timezone: 'Asia/Tokyo' }),
}));

function settings(
  patch: {
    booking?: Partial<ShopSettings['booking']>;
    hours?: Partial<ShopSettings['hours']>;
    capacity?: Partial<ShopSettings['capacity']>;
  } = {},
): ShopSettings {
  return {
    booking: {
      slotIntervalMin: 15,
      leadTimeMin: 60,
      horizonDays: 60,
      cancelDeadlineHours: 24,
      allowStaffSelection: true,
      requireApproval: false,
      maxServicesPerBooking: 5,
      autoAssignFree: true,
      advanceMonths: null,
      cutoffType: 'same_day',
      cutoffDaysBefore: 1,
      cutoffTime: '24:00',
      calcMethod: 'calendar',
      acceptSameStartTime: false,
      acceptOutsideHours: false,
      ...patch.booking,
    },
    reminders: { enabled: true, confirmation: true, dayBeforeHour: 18, sameDayHoursBefore: 3 },
    pos: {
      pointRateBp: 100,
      pointExpiryDays: 365,
      roundingMode: 'floor',
      receiptFooter: '',
      requireOpenRegister: true,
    },
    review: { autoRequest: true, requestDelayHours: 3 },
    seats: { alertEnabled: false, limit: 0 },
    hours: {
      holidayEnabled: false,
      holidayClosed: false,
      holidayOpenTime: '10:00',
      holidayCloseTime: '19:00',
      ...patch.hours,
    },
    capacity: {
      default: null,
      weekdays: [null, null, null, null, null, null, null],
      holiday: null,
      ...patch.capacity,
    },
  };
}

const shopOf = (s: ShopSettings) =>
  ({
    id: 'shop-1',
    name: '渋谷店',
    slug: 'shibuya',
    timezone: 'Asia/Tokyo',
    settings: s,
  }) as unknown as Shop;

// open every day except Tuesday, 10:00–20:00 (Sunday until 19:00)
const hours: BusinessHour[] = [0, 1, 3, 4, 5, 6].map((weekday) => ({
  id: `h${weekday}`,
  weekday,
  open_time: '10:00',
  close_time: weekday === 0 ? '19:00' : '20:00',
}));
const today = todayIn('Asia/Tokyo');
const closureDate = addDays(today, 30);
const exceptions: CalendarException[] = [
  {
    id: 'e1',
    date: closureDate,
    is_closed: true,
    open_time: null,
    close_time: null,
    note: '内装工事',
  },
  {
    id: 'e2',
    date: addDays(today, 40),
    is_closed: false,
    open_time: '12:00',
    close_time: '17:00',
    note: '短縮営業',
  },
];

function mount(initial: ShopSettings = settings()) {
  let current = initial;
  vi.spyOn(orgApi, 'shop').mockImplementation(() => Promise.resolve(shopOf(current)));
  const updateShop = vi.spyOn(orgApi, 'updateShop').mockImplementation((_id, input) => {
    const p = (input.settings ?? {}) as Record<string, Record<string, unknown>>;
    current = {
      ...current,
      booking: { ...current.booking, ...p.booking },
      hours: { ...current.hours, ...p.hours },
      capacity: { ...current.capacity, ...p.capacity },
    } as ShopSettings;
    return Promise.resolve(shopOf(current));
  });
  vi.spyOn(schedulesApi, 'businessHours').mockResolvedValue(hours);
  vi.spyOn(schedulesApi, 'exceptions').mockResolvedValue(exceptions);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/app/reservation-settings']}>
          <ReservationSettings />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { updateShop };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ReservationSettings (予約受付設定)', () => {
  it('営業時間・定休日: one row per weekday, closed days are not sent, holiday hours have their own row', async () => {
    const user = userEvent.setup();
    const replace = vi
      .spyOn(schedulesApi, 'replaceBusinessHours')
      .mockImplementation((_id, rows) =>
        Promise.resolve(
          rows.map((r, i) => ({
            id: `n${i}`,
            weekday: r.weekday,
            open_time: r.openTime,
            close_time: r.closeTime,
          })),
        ),
      );
    const { updateShop } = mount();
    expect(
      await screen.findByRole('heading', { level: 1, name: '予約受付設定' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      '営業時間・定休日',
      '受付可能数',
      '予約設定',
      'スタッフ別設定',
    ]);
    expect(schedulesApi.exceptions).toHaveBeenCalledWith('shop-1', today, addDays(today, 730));
    expect(screen.getByLabelText('日曜 閉店')).toHaveValue('19:00');
    expect(screen.getByLabelText('月曜 開店')).toHaveValue('10:00');
    expect(screen.getByLabelText('火曜 休')).toBeChecked();
    expect(screen.getByLabelText('火曜 開店')).toBeDisabled();
    expect(screen.queryByLabelText('祝日 開店')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('月曜 開店'), { target: { value: '11:00' } });
    await user.click(screen.getByLabelText('水曜 休'));
    // 祝日の営業時間を個別に設定する is saved at once and adds the 祝 row
    await user.click(screen.getByRole('checkbox', { name: '祝日の営業時間を個別に設定する' }));
    await waitFor(() =>
      expect(updateShop).toHaveBeenCalledWith('shop-1', {
        settings: { hours: { holidayEnabled: true } },
      }),
    );
    fireEvent.change(await screen.findByLabelText('祝日 閉店'), { target: { value: '18:00' } });

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace).toHaveBeenCalledWith('shop-1', [
      { weekday: 0, openTime: '10:00', closeTime: '19:00' },
      { weekday: 1, openTime: '11:00', closeTime: '20:00' },
      { weekday: 4, openTime: '10:00', closeTime: '20:00' },
      { weekday: 5, openTime: '10:00', closeTime: '20:00' },
      { weekday: 6, openTime: '10:00', closeTime: '20:00' },
    ]);
    await waitFor(() =>
      expect(updateShop).toHaveBeenLastCalledWith('shop-1', {
        settings: {
          hours: { holidayClosed: false, holidayOpenTime: '10:00', holidayCloseTime: '18:00' },
        },
      }),
    );
    expect(await screen.findByText('営業時間を保存しました')).toBeInTheDocument();
  });

  it('臨時休業日: lists closures only, adds one with a reason and deletes', async () => {
    const user = userEvent.setup();
    const upsert = vi.spyOn(schedulesApi, 'upsertException').mockResolvedValue(exceptions[0]!);
    const remove = vi.spyOn(schedulesApi, 'deleteException').mockResolvedValue(undefined);
    mount();
    const list = await screen.findByTestId('closures');
    expect(within(list).getByText('内装工事')).toBeInTheDocument();
    expect(screen.queryByText('短縮営業')).not.toBeInTheDocument();

    const add = screen.getByRole('button', { name: '追加' });
    expect(add).toBeDisabled();
    const date = addDays(today, 60);
    fireEvent.change(screen.getByLabelText('臨時休業日'), { target: { value: date } });
    expect(screen.getByLabelText('臨時休業日')).toHaveAttribute('min', today);
    await user.type(screen.getByLabelText('理由'), '年末年始');
    await user.click(add);
    await waitFor(() =>
      expect(upsert).toHaveBeenCalledWith('shop-1', date, { isClosed: true, note: '年末年始' }),
    );

    await user.click(within(list).getByRole('button', { name: `${closureDate} を削除` }));
    expect(remove).toHaveBeenCalledWith('shop-1', closureDate);
  });

  it('受付可能数: closed days show 定休日; numbers are saved per weekday, empty = default / no limit', async () => {
    const user = userEvent.setup();
    const { updateShop } = mount(
      settings({
        capacity: { default: 3, weekdays: [null, 11, null, null, null, null, null], holiday: null },
      }),
    );
    await user.click(await screen.findByRole('tab', { name: '受付可能数' }));
    expect(screen.getByText('定休日')).toBeInTheDocument();
    expect(screen.getByLabelText('月 受付可能数')).toHaveValue(11);
    // a day without its own number shows the default
    expect(screen.getByLabelText('水 受付可能数')).toHaveValue(3);
    expect(screen.queryByLabelText('祝 受付可能数')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('水 受付可能数'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('月 受付可能数'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(updateShop).toHaveBeenCalledWith('shop-1', {
        settings: {
          capacity: { weekdays: [null, null, null, 8, null, null, null], holiday: null },
        },
      }),
    );
    expect(await screen.findByText('受付可能数を保存しました')).toBeInTheDocument();
  });

  it('予約設定: the older "N days" stays until months are chosen; cutoff, method, default capacity and switches are saved', async () => {
    const user = userEvent.setup();
    const { updateShop } = mount();
    await user.click(await screen.findByRole('tab', { name: '予約設定' }));
    expect(screen.getByRole('combobox', { name: '受付開始' })).toHaveTextContent(
      '60日先まで（現在の設定）',
    );
    expect(screen.getByRole('combobox', { name: '当日の受付締切' })).toHaveTextContent(
      '1時間前まで',
    );
    expect(screen.getByLabelText('デフォルト受付可能数')).toHaveValue(null);

    // saving without touching 受付開始 keeps the N-days setting (advanceMonths is not sent)
    await user.click(screen.getByRole('switch', { name: '営業時間外の予約を受付する' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateShop).toHaveBeenCalledTimes(1));
    expect(updateShop.mock.calls[0]![1]).toEqual({
      settings: {
        booking: {
          cutoffType: 'same_day',
          leadTimeMin: 60,
          cutoffDaysBefore: 1,
          cutoffTime: '24:00',
          calcMethod: 'calendar',
          acceptSameStartTime: false,
          acceptOutsideHours: true,
        },
        capacity: { default: null },
      },
    });

    await user.click(screen.getByRole('combobox', { name: '受付開始' }));
    await user.click(screen.getByRole('option', { name: '2ヶ月先まで' }));
    await user.click(screen.getByRole('radio', { name: /前日以前に締め切る/ }));
    expect(screen.queryByRole('combobox', { name: '当日の受付締切' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: '締切日' }));
    await user.click(screen.getByRole('option', { name: '3日前' }));
    await user.click(screen.getByRole('combobox', { name: '締切時刻' }));
    await user.click(screen.getByRole('option', { name: '18時まで' }));
    await user.click(screen.getByRole('combobox', { name: '受付期間の計算方法' }));
    await user.click(screen.getByRole('option', { name: '営業日で計算（休業日を除く）' }));
    expect(
      screen.getByText('定休日と臨時休業日を除いた営業日数でカウントします'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('デフォルト受付可能数'), { target: { value: '11' } });
    await user.click(screen.getByRole('switch', { name: '開始時刻が同じ予約を受付する' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateShop).toHaveBeenCalledTimes(2));
    expect(updateShop.mock.calls[1]![1]).toEqual({
      settings: {
        booking: {
          advanceMonths: 2,
          cutoffType: 'days_before',
          cutoffDaysBefore: 3,
          cutoffTime: '18:00',
          calcMethod: 'business_days',
          acceptSameStartTime: true,
          acceptOutsideHours: true,
        },
        capacity: { default: 11 },
      },
    });
    // read back from the saved settings: the N-days option is gone
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '受付開始' })).toHaveTextContent('2ヶ月先まで'),
    );
    await user.click(screen.getByRole('combobox', { name: '受付開始' }));
    expect(screen.getAllByRole('option')).toHaveLength(12);
  });

  it('スタッフ別設定: shows who has their own hours / rules and opens the staff settings', async () => {
    const user = userEvent.setup();
    const staff = [
      { id: 's1', display_name: '山田 花子' },
      { id: 's2', display_name: '鈴木 一郎' },
    ] as unknown as Staff[];
    const list = vi.spyOn(orgApi, 'staff').mockResolvedValue(staff);
    vi.spyOn(staffScreenApi, 'settingsOverview').mockResolvedValue({
      hours: ['s1'],
      reservation: ['s2'],
    });
    vi.spyOn(staffScreenApi, 'businessHours').mockResolvedValue({
      configured: true,
      hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        openTime: '10:00',
        closeTime: '19:00',
        isClosed: false,
      })),
    });
    vi.spyOn(staffScreenApi, 'reservationSettings').mockResolvedValue({
      individual: false,
      settings: {
        advanceBookingDays: 60,
        sameDayCutoffHours: 1,
        maxConcurrent: 1,
        acceptSameStartTime: false,
        acceptOutsideHours: false,
      },
    });
    mount();
    await user.click(await screen.findByRole('tab', { name: 'スタッフ別設定' }));
    const rows = await screen.findByTestId('staff-settings-list');
    expect(list).toHaveBeenCalledWith({ shopId: 'shop-1' });
    const first = within(rows).getByText('山田 花子').closest('[role=button]') as HTMLElement;
    expect(within(first).getByText('営業時間: 個別設定あり')).toBeInTheDocument();
    expect(within(first).getByText('予約設定: サロン設定')).toBeInTheDocument();
    const second = within(rows).getByText('鈴木 一郎').closest('[role=button]') as HTMLElement;
    expect(within(second).getByText('営業時間: サロン設定')).toBeInTheDocument();
    expect(within(second).getByText('予約設定: 個別設定あり')).toBeInTheDocument();

    await user.click(first);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '山田 花子 - 設定' })).toBeInTheDocument();
    expect(await within(dialog).findByText('個別設定済み')).toBeInTheDocument();
    expect(staffScreenApi.businessHours).toHaveBeenCalledWith('s1', 'shop-1');
  });
});
