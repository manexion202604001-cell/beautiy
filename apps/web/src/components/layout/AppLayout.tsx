import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { authApi } from '../../api/auth';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { useTheme } from '../../lib/theme';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Field,
  Icon,
  IconButton,
  Input,
  Switch,
  useToast,
} from '../ui';
import { Menu } from '../ui/Menu';
import { NAV } from './nav';

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-fg">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M7 16c0-2.4 1.8-3.4 5-3.4s5-1.3 5-3.5C17 7.2 15 6 12.4 6 10.3 6 8.7 6.8 7.9 8.1" />
          <circle cx="16.5" cy="17" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-fg">Salon OS</span>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  return (
    <nav aria-label="メインメニュー" className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-5">
        <Logo />
      </div>
      <div className="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-3 pb-6 pt-2">
        {NAV.map((section, si) => (
          <div key={si}>
            {section.label ? (
              <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                {section.label}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {section.items
                .filter((it) => !it.permissions || it.permissions.some((p) => can(p)))
                .map((it) =>
                  it.soon ? (
                    <li key={it.to}>
                      <span
                        aria-disabled="true"
                        title="この機能は準備中です"
                        className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-subtle"
                      >
                        <Icon name={it.icon} size={18} />
                        <span className="flex-1">{it.label}</span>
                        <Badge size="sm" tone="outline">
                          準備中
                        </Badge>
                      </span>
                    </li>
                  ) : (
                    <li key={it.to}>
                      <NavLink
                        to={it.to}
                        end={it.end}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            'flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
                            isActive
                              ? 'bg-primary-soft text-primary'
                              : 'text-muted hover:bg-surface-2 hover:text-fg',
                          )
                        }
                      >
                        <Icon name={it.icon} size={18} />
                        {it.label}
                      </NavLink>
                    </li>
                  ),
                )}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function ShopSwitcher() {
  const { shops, currentShop, setCurrentShopId } = useAuth();
  if (!currentShop) return null;
  if (shops.length <= 1) {
    return (
      <div className="flex min-w-0 items-center gap-2 px-2 text-[13px] font-medium text-fg">
        <Icon name="store" size={16} className="shrink-0 text-muted" />
        <span className="truncate">{currentShop.name}</span>
      </div>
    );
  }
  return (
    <Menu
      label={`店舗を切り替え（現在: ${currentShop.name}）`}
      align="left"
      triggerClassName="flex max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-fg hover:bg-surface-2"
      trigger={
        <>
          <Icon name="store" size={16} className="shrink-0 text-muted" />
          <span className="truncate">{currentShop.name}</span>
          <Icon name="chevron-down" size={14} className="shrink-0 text-muted" />
        </>
      }
      items={shops.map((s) => ({
        key: s.id,
        label: s.name,
        description: s.slug,
        checked: s.id === currentShop.id,
        onSelect: () => setCurrentShopId(s.id),
      }))}
    />
  );
}

function OrgSwitcher() {
  const { me, switchOrganization } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  if (!me || me.organizations.length <= 1) return null;
  return (
    <Menu
      label="法人を切り替え"
      align="left"
      triggerClassName="hidden md:flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
      trigger={
        <>
          <span className="max-w-[10rem] truncate">{me.organization.name}</span>
          <Icon name="chevron-down" size={14} />
        </>
      }
      items={me.organizations.map((o) => ({
        key: o.id,
        label: o.name,
        checked: o.id === me.organization.id,
        onSelect: () => {
          if (o.id === me.organization.id) return;
          switchOrganization(o.id)
            .then(() => {
              navigate('/app');
              toast.success(`${o.name} に切り替えました`);
            })
            .catch((e) => toast.error(e));
        },
      }))}
    />
  );
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 10) return setError('新しいパスワードは10文字以上で入力してください');
    if (next !== confirm) return setError('確認用パスワードが一致しません');
    setSaving(true);
    try {
      await authApi.changePassword(current, next);
      toast.success('パスワードを変更しました', '安全のため再度ログインしてください');
      onClose();
      await logout();
      navigate('/login');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="パスワード変更"
      description="変更すると他の端末のセッションはすべてログアウトされます。"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" type="submit" form="pw-form" loading={saving}>
            変更する
          </Button>
        </>
      }
    >
      <form id="pw-form" onSubmit={submit} className="space-y-4">
        <Field label="現在のパスワード" required>
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="新しいパスワード" hint="10文字以上" required>
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="新しいパスワード（確認）" required error={error}>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function MfaDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open && me) setEnabled(me.user.mfa_enabled);
  }, [open, me]);
  const save = async () => {
    setSaving(true);
    try {
      await authApi.setMfa(enabled);
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(enabled ? '二段階認証を有効にしました' : '二段階認証を無効にしました');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="二段階認証（メールOTP）"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <Switch
        checked={enabled}
        onChange={setEnabled}
        label="ログイン時に確認コードを要求する"
        description={`有効にすると、ログインのたびに ${me?.user.email ?? '登録メールアドレス'} へ6桁のコードを送信します。`}
      />
    </Dialog>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const { pref, set } = useTheme();
  const [pwOpen, setPwOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);
  if (!me) return null;
  return (
    <>
      <Menu
        label="アカウントメニュー"
        triggerClassName="flex items-center gap-2 rounded-full p-0.5 pr-2 hover:bg-surface-2"
        trigger={
          <>
            <Avatar name={me.staff.display_name} color={me.staff.color} size={30} />
            <span className="hidden max-w-[8rem] truncate text-[13px] font-medium text-fg md:inline">
              {me.staff.display_name}
            </span>
          </>
        }
        header={
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-fg">{me.staff.display_name}</p>
            <p className="truncate text-xs text-muted">
              {me.staff.role_name} ・ {me.user.email}
            </p>
          </div>
        }
        items={[
          { key: 'pw', label: 'パスワード変更', icon: 'key', onSelect: () => setPwOpen(true) },
          {
            key: 'mfa',
            label: '二段階認証',
            icon: 'lock',
            description: me.user.mfa_enabled ? '有効' : '無効',
            onSelect: () => setMfaOpen(true),
          },
          'separator',
          {
            key: 'theme-system',
            label: 'テーマ: システム',
            icon: 'layers',
            checked: pref === 'system',
            onSelect: () => set('system'),
          },
          {
            key: 'theme-light',
            label: 'テーマ: ライト',
            icon: 'sun',
            checked: pref === 'light',
            onSelect: () => set('light'),
          },
          {
            key: 'theme-dark',
            label: 'テーマ: ダーク',
            icon: 'moon',
            checked: pref === 'dark',
            onSelect: () => set('dark'),
          },
          'separator',
          {
            key: 'logout',
            label: 'ログアウト',
            icon: 'logout',
            tone: 'danger',
            onSelect: () => {
              void logout().then(() => navigate('/login'));
            },
          },
        ]}
      />
      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
      <MfaDialog open={mfaOpen} onClose={() => setMfaOpen(false)} />
    </>
  );
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { me } = useAuth();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-card"
      >
        本文へスキップ
      </a>
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 border-r border-border bg-surface lg:block">
        <Sidebar />
      </aside>
      {/* mobile / tablet drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="animate-fade-in absolute inset-0 bg-[var(--overlay)]"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="animate-drawer-in absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-surface shadow-card">
            <div className="absolute right-2 top-2">
              <IconButton
                icon="x"
                label="メニューを閉じる"
                size="sm"
                onClick={() => setMobileOpen(false)}
              />
            </div>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-surface/90 px-3 backdrop-blur sm:px-5">
          <IconButton
            icon="menu"
            label="メニューを開く"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
          />
          <div className="lg:hidden">
            <span className="sr-only">Salon OS</span>
          </div>
          <OrgSwitcher />
          <ShopSwitcher />
          <div className="flex-1" />
          {me && me.organization.status === 'trial' ? (
            <Badge tone="info" className="hidden sm:inline-flex">
              トライアル中
            </Badge>
          ) : null}
          <UserMenu />
        </header>
        <main id="main" className="mx-auto w-full max-w-[1600px] px-3 py-5 sm:px-6 sm:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
