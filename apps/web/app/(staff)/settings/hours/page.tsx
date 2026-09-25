import Link from 'next/link';
import { jaWeekday, minutesToHHMM, todayIn } from '@salonos/core';
import { requirePage } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { PageHeader, Card, Field, Empty } from '@/components/ui';
import { ActionForm, ConfirmAction, SubmitButton } from '@/components/client';
import { addHolidayAction, removeHolidayAction, saveHoursAction } from './actions';

export const metadata = { title: '営業時間・休業日' };

const ORDER = [1, 2, 3, 4, 5, 6, 0];

export default async function HoursPage({ searchParams }: { searchParams: Promise<{ past?: string }> }) {
  const ctx = await requirePage('settings.shop');
  const sp = await searchParams;
  const today = todayIn(ctx.shop.timezone);
  const showPast = sp.past === '1';
  const [hours, holidays] = await Promise.all([
    prisma.businessHour.findMany({ where: { shopId: ctx.shop.id } }),
    prisma.shopHoliday.findMany({ where: { shopId: ctx.shop.id, ...(showPast ? {} : { date: { gte: today } }) }, orderBy: { date: showPast ? 'desc' : 'asc' }, take: 200 }),
  ]);
  const byWd = new Map(hours.map((h) => [h.weekday, h]));

  return (
    <>
      <PageHeader title="営業時間・休業日" back={{ href: '/settings', label: '設定' }} sub={`${ctx.shop.name} ・ ネット予約の空き枠と予約台帳の営業時間に反映されます`} />
      <div className="split">
        <Card title="曜日ごとの営業時間">
          <ActionForm action={saveHoursAction}>
            {ORDER.map((wd) => {
              const h = byWd.get(wd);
              return (
                <div key={wd} className="hours-row">
                  <b>{jaWeekday(wd)}曜日</b>
                  <label className="checkbox"><input type="checkbox" name={`closed_${wd}`} defaultChecked={h ? h.closed : true} />定休日</label>
                  <div className="times">
                    <label className="sr-only" htmlFor={`open_${wd}`}>{jaWeekday(wd)}曜日 開店</label>
                    <input id={`open_${wd}`} name={`open_${wd}`} type="time" step={900} className="input sm" defaultValue={minutesToHHMM(h?.openMin ?? 600)} />
                    <span className="sub">〜</span>
                    <label className="sr-only" htmlFor={`close_${wd}`}>{jaWeekday(wd)}曜日 閉店</label>
                    <input id={`close_${wd}`} name={`close_${wd}`} type="time" step={900} className="input sm" defaultValue={minutesToHHMM(Math.min(h?.closeMin ?? 1200, 1439))} />
                  </div>
                </div>
              );
            })}
            {hours.length === 0 && <div className="alert warn" style={{ marginTop: 10 }}>営業時間が未設定です。保存するとネット予約の受付が始まります。</div>}
            <div className="form-actions"><SubmitButton>営業時間を保存</SubmitButton></div>
          </ActionForm>
        </Card>

        <div className="stack">
          <Card title="休業日を追加">
            <ActionForm action={addHolidayAction} resetOnSuccess>
              <div className="form-grid">
                <Field label="開始日" htmlFor="h-date" required><input id="h-date" name="date" type="date" className="input" min={today} required /></Field>
                <Field label="終了日（連休の場合）" htmlFor="h-end"><input id="h-end" name="endDate" type="date" className="input" min={today} /></Field>
                <Field label="理由（予約ページには表示されません）" htmlFor="h-reason" full><input id="h-reason" name="reason" className="input" maxLength={100} placeholder="例：研修のため臨時休業" /></Field>
              </div>
              <div className="form-actions"><SubmitButton>追加</SubmitButton></div>
            </ActionForm>
          </Card>
          <Card flush title={showPast ? '休業日（過去を含む）' : '今後の休業日'} actions={<Link className="btn ghost sm" href={showPast ? '/settings/hours' : '/settings/hours?past=1'}>{showPast ? '今後のみ表示' : '過去も表示'}</Link>}>
            {holidays.length === 0 ? <Empty title="登録された休業日はありません" /> : (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {holidays.map((h) => {
                      const wd = new Date(h.date + 'T00:00:00Z').getUTCDay();
                      return (
                        <tr key={h.id} className={h.date < today ? 'row-muted' : ''}>
                          <td className="nowrap">{h.date.replaceAll('-', '/')}（{jaWeekday(wd)}）</td>
                          <td>{h.reason ?? <span className="sub">—</span>}</td>
                          <td className="right"><ConfirmAction action={removeHolidayAction} fields={{ id: h.id }} confirm={`${h.date} の休業日を削除しますか？`} className="btn ghost sm">削除</ConfirmAction></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
