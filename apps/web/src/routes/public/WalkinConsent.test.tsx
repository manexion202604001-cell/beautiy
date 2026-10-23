import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publicMessagingApi } from '../../api/messaging';
import { walkinApi, type PublicWalkinView } from '../../api/walkin';
import { ApiError } from '../../lib/api';
import { _resetLiffForTests } from '../../lib/liff';
import WalkinConsent from './WalkinConsent';

const view: PublicWalkinView = {
  shop: { name: 'テストサロン 本店' },
  staff: { id: 'staff-1', name: '佐藤' },
  consent: {
    templateId: 't-consent',
    lineageId: 'l-consent',
    kind: 'consent',
    name: '施術同意書',
    version: 1,
    fields: [],
    bodyMarkdown: '## 個人情報について\n- 施術以外の目的で利用しません\n\n## その他\n体調がすぐれない場合はお申し出ください。',
    requiresSignature: false,
  },
};

function mount(data: PublicWalkinView | Error = view) {
  const publicView = vi.spyOn(walkinApi, 'publicView');
  if (data instanceof Error) publicView.mockRejectedValue(data);
  else publicView.mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/consent/honten?staff=staff-1']}>
        <Routes>
          <Route path="/consent/:shopSlug" element={<WalkinConsent />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  _resetLiffForTests();
  delete (window as unknown as { liff?: unknown }).liff;
  vi.spyOn(publicMessagingApi, 'liffConfig').mockResolvedValue({ liffId: null, friendUrl: null });
});

describe('WalkinConsent (/consent/:shopSlug)', () => {
  it('collects the details and the agreement, then offers the counselling sheets', async () => {
    const user = userEvent.setup();
    const submit = vi
      .spyOn(walkinApi, 'publicSubmit')
      .mockResolvedValue({ ok: true, intakeId: 'w1', submittedAt: '2026-10-13T03:00:00.000Z', token: 'tok-1234567890', expiresAt: '2026-10-14T03:00:00.000Z' });
    const counseling = vi
      .spyOn(walkinApi, 'publicCounseling')
      .mockResolvedValue({ ok: true, intakeId: 'w1', categories: ['eye_counseling'], submittedAt: '2026-10-13T03:05:00.000Z' });
    mount();

    expect(await screen.findByRole('heading', { name: '施術同意書の確認とご提出' })).toBeInTheDocument();
    expect(walkinApi.publicView).toHaveBeenCalledWith('honten', { staff: 'staff-1', form: undefined });
    expect(screen.getByText('テストサロン 本店')).toBeInTheDocument();
    expect(screen.getByText('担当: 佐藤')).toBeInTheDocument();
    // the consent text is shown as collapsible sections
    expect(screen.getByText('個人情報について')).toBeInTheDocument();
    expect(screen.getByText('施術以外の目的で利用しません')).toBeInTheDocument();

    // nothing can be submitted before agreeing; required details are checked
    const send = screen.getByRole('button', { name: '同意書を提出する' });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '上記の内容に同意します' }));
    await user.click(send);
    expect(await screen.findByText('未入力の項目があります')).toBeInTheDocument();
    expect(screen.getByText('姓を入力してください')).toBeInTheDocument();
    expect(screen.getByText('電話番号を入力してください')).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/お名前（姓）/), '来店');
    await user.type(screen.getByLabelText(/お名前（名）/), '花子');
    await user.type(screen.getByLabelText(/フリガナ（セイ）/), 'ライテン');
    await user.type(screen.getByLabelText(/フリガナ（メイ）/), 'ハナコ');
    await user.type(screen.getByLabelText(/生年月日/), '1990-04-12');
    await user.type(screen.getByLabelText(/電話番号/), '090-1111-2222');
    await user.type(screen.getByLabelText(/ご来店のきっかけ/), 'Instagram');
    await user.click(send);
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith('honten', {
        staffId: 'staff-1',
        templateId: 't-consent',
        customer: {
          lastName: '来店',
          firstName: '花子',
          lastNameKana: 'ライテン',
          firstNameKana: 'ハナコ',
          birthday: '1990-04-12',
          phone: '090-1111-2222',
          occupation: null,
          visitReason: 'Instagram',
        },
        agreed: true,
        answers: {},
      }),
    );

    // counselling sheet: choose the category of today's treatment
    expect(await screen.findByText('同意書を提出しました。')).toBeInTheDocument();
    for (const label of ['髪', '目', 'エクステ', '眉', 'ネイル', '顔', '体']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: /^目/ }));
    // nothing answered → nothing is sent
    await user.click(screen.getByRole('button', { name: '送信する' }));
    expect(await screen.findByText('ご記入のうえ送信してください')).toBeInTheDocument();
    expect(counseling).not.toHaveBeenCalled();

    const allergies = screen.getByRole('group', { name: 'アレルギーについて' });
    await user.click(within(allergies).getByRole('button', { name: '花粉' }));
    await user.click(within(allergies).getByRole('button', { name: '金属' }));
    // follow-up inputs open for the trigger answer only
    const condition = screen.getByRole('group', { name: 'お目元周りで状態が悪い箇所はございますか？' });
    expect(within(condition).queryByLabelText('箇所')).not.toBeInTheDocument();
    await user.click(within(condition).getByRole('button', { name: 'はい' }));
    await user.type(within(condition).getByLabelText('箇所'), '右目');
    await user.type(screen.getByLabelText('ご不明な点、ご質問はございますか？'), '特にありません');
    await user.click(screen.getByRole('button', { name: '送信する' }));
    await waitFor(() =>
      expect(counseling).toHaveBeenCalledWith('tok-1234567890', {
        eye_counseling: { allergies: ['花粉', '金属'], eye_condition: 'はい', eye_condition_area: '右目', questions: '特にありません' },
      }),
    );
    expect(await screen.findByText('記入済み（修正する）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '記入を終了する' }));
    expect(await screen.findByRole('heading', { name: 'ご記入ありがとうございました' })).toBeInTheDocument();
  });

  it('opened from the LIFF QR inside LINE, sends the LINE id token with the consent', async () => {
    const user = userEvent.setup();
    vi.spyOn(publicMessagingApi, 'liffConfig').mockResolvedValue({ liffId: '1650000000-abcdEF', friendUrl: null });
    const init = vi.fn().mockResolvedValue(undefined);
    // the LIFF SDK (normally loaded from static.line-scdn.net)
    (window as unknown as { liff: unknown }).liff = { init, isLoggedIn: () => true, isInClient: () => true, login: vi.fn(), getIDToken: () => 'line-id-token' };
    const submit = vi
      .spyOn(walkinApi, 'publicSubmit')
      .mockResolvedValue({ ok: true, intakeId: 'w1', submittedAt: '2026-10-13T03:00:00.000Z', token: 'tok-1234567890', expiresAt: '2026-10-14T03:00:00.000Z', line: true });
    mount();
    await screen.findByRole('heading', { name: '施術同意書の確認とご提出' });
    await waitFor(() => expect(init).toHaveBeenCalledWith({ liffId: '1650000000-abcdEF' }));
    expect(publicMessagingApi.liffConfig).toHaveBeenCalledWith({ shop: 'honten' });

    await user.type(screen.getByLabelText(/お名前（姓）/), '来店');
    await user.type(screen.getByLabelText(/お名前（名）/), '花子');
    await user.type(screen.getByLabelText(/フリガナ（セイ）/), 'ライテン');
    await user.type(screen.getByLabelText(/フリガナ（メイ）/), 'ハナコ');
    await user.type(screen.getByLabelText(/生年月日/), '1990-04-12');
    await user.type(screen.getByLabelText(/電話番号/), '090-1111-2222');
    await user.click(screen.getByRole('checkbox', { name: '上記の内容に同意します' }));
    await user.click(screen.getByRole('button', { name: '同意書を提出する' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('honten', expect.objectContaining({ lineIdToken: 'line-id-token' })));
  });

  it('tells the customer to ask staff when the QR cannot be used', async () => {
    mount(new ApiError({ status: 404, code: 'NOT_FOUND', category: 'not_found', message: '店舗が見つかりません' }));
    expect(await screen.findByText('このQRコードは現在ご利用いただけません')).toBeInTheDocument();
  });

  it('says so when the shop has no consent form yet', async () => {
    mount({ ...view, consent: null });
    expect(await screen.findByText('同意書の準備ができていません')).toBeInTheDocument();
  });
});
