import { Hono, type Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { Bindings, Variables, Staff } from '../types';
import { signToken, staffAuth, hashPassword, verifyPassword, rehashIfLegacy } from '../middleware/auth';
import { EmailService } from '../services/emailService';
import { rateLimit } from '../middleware/rateLimit';
import { generateTotpSecret, verifyTotp, buildTotpUri } from '../utils/totp';

function generateStaffCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (100000 + (array[0] % 900000)).toString();
}

function generateVerificationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ログイン試行をアクセスログとして記録（退職アカウントでの試行も含む）
async function recordLoginAttempt(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  data: { email: string; staffId: string | null; success: boolean; reason: string },
): Promise<void> {
  try {
    await c.env.DB.prepare(
      `INSERT INTO login_attempts (id, email, staff_id, success, reason, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      data.email || null,
      data.staffId,
      data.success ? 1 : 0,
      data.reason,
      c.req.header('cf-connecting-ip') || null,
      c.req.header('user-agent') || null,
    ).run();
  } catch (e) {
    console.error('Failed to record login attempt:', e);
  }
}

export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Login (supports email or login_id) - rate limited: 5 attempts per 60s
authRoutes.post('/login', rateLimit(5, 60), async (c) => {
  const { email, password, totp_code } = await c.req.json<{ email: string; password: string; totp_code?: string }>();

  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  // Try email first, then login_id
  let staff = await c.env.DB.prepare('SELECT * FROM staff WHERE email = ? AND is_active = 1')
    .bind(email)
    .first<Staff>();

  if (!staff) {
    staff = await c.env.DB.prepare('SELECT * FROM staff WHERE login_id = ? AND is_active = 1')
      .bind(email)
      .first<Staff>();
  }

  if (!staff) {
    // アクティブなスタッフが見つからない → 退職/無効アカウントでの試行か確認して記録
    const inactive = await c.env.DB.prepare(
      'SELECT id FROM staff WHERE (email = ? OR login_id = ?) AND is_active = 0'
    ).bind(email, email).first<{ id: string }>();
    await recordLoginAttempt(c, {
      email,
      staffId: inactive?.id || null,
      success: false,
      reason: inactive ? 'retired_or_inactive_account' : 'no_account',
    });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const isValidPassword = await verifyPassword(password, staff.password_hash);
  if (!isValidPassword) {
    await recordLoginAttempt(c, { email, staffId: staff.id, success: false, reason: 'wrong_password' });
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // Transparently migrate legacy SHA-256 hashes to PBKDF2
  c.executionCtx.waitUntil(rehashIfLegacy(c.env.DB, 'staff', staff.id, password, staff.password_hash));

  // Skip email_verified check for login_id users (they don't have email yet)
  const isLoginIdUser = !staff.email && staff.login_id;
  if (!isLoginIdUser && staff.email_verified === 0) {
    return c.json({ error: 'メールアドレスが未認証です。メールをご確認ください。', code: 'EMAIL_NOT_VERIFIED' }, 403);
  }

  // TOTP verification (if enabled and activated for this staff)
  if (staff.totp_secret && !staff.totp_secret.startsWith('pending:')) {
    if (!totp_code) {
      return c.json({ error: 'ワンタイムパスワードを入力してください', code: 'TOTP_REQUIRED' }, 403);
    }
    const isValidTotp = await verifyTotp(staff.totp_secret, totp_code);
    if (!isValidTotp) {
      return c.json({ error: 'ワンタイムパスワードが正しくありません', code: 'TOTP_INVALID' }, 401);
    }
  }

  const token = await signToken(
    {
      sub: staff.id,
      type: 'staff',
      role: staff.role,
      storeId: staff.store_id || undefined,
    },
    c
  );

  setCookie(c, 'auth_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain: c.env.COOKIE_DOMAIN || undefined,
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });

  await recordLoginAttempt(c, { email, staffId: staff.id, success: true, reason: 'success' });

  return c.json({
    staff: {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      store_id: staff.store_id,
      avatar_url: staff.avatar_url,
    },
    token,
    must_change_password: staff.must_change_password === 1,
    onboarding_completed: staff.onboarding_completed === 1,
  });
});

// TOTP setup - generate secret and return QR URI
authRoutes.post('/totp/setup', staffAuth, async (c) => {
  const staff = c.get('staff')!;
  const secret = generateTotpSecret();
  const account = staff.login_id || staff.email || staff.name;
  const uri = buildTotpUri(secret, account);

  // Store temporarily — not activated until verified
  await c.env.DB.prepare(
    "UPDATE staff SET totp_secret = ? WHERE id = ?"
  ).bind(`pending:${secret}`, staff.id).run();

  return c.json({ secret, uri });
});

// TOTP verify & activate
authRoutes.post('/totp/verify', staffAuth, async (c) => {
  const staff = c.get('staff')!;
  const { code } = await c.req.json<{ code: string }>();

  if (!staff.totp_secret?.startsWith('pending:')) {
    return c.json({ error: 'TOTP設定が開始されていません' }, 400);
  }

  const secret = staff.totp_secret.replace('pending:', '');
  const isValid = await verifyTotp(secret, code);
  if (!isValid) {
    return c.json({ error: 'コードが正しくありません。もう一度お試しください。' }, 400);
  }

  // Activate TOTP
  await c.env.DB.prepare(
    "UPDATE staff SET totp_secret = ? WHERE id = ?"
  ).bind(secret, staff.id).run();

  return c.json({ success: true, message: 'ワンタイムパスワードが有効になりました' });
});

// TOTP disable
authRoutes.post('/totp/disable', staffAuth, async (c) => {
  const staff = c.get('staff')!;
  const { password } = await c.req.json<{ password: string }>();

  const isValid = await verifyPassword(password, staff.password_hash);
  if (!isValid) {
    return c.json({ error: 'パスワードが正しくありません' }, 401);
  }

  await c.env.DB.prepare(
    "UPDATE staff SET totp_secret = NULL WHERE id = ?"
  ).bind(staff.id).run();

  return c.json({ success: true, message: 'ワンタイムパスワードが無効になりました' });
});

// Logout
authRoutes.post('/logout', (c) => {
  deleteCookie(c, 'auth_token', { path: '/', domain: c.env.COOKIE_DOMAIN || undefined });
  return c.json({ success: true });
});

// Get current user
authRoutes.get('/me', staffAuth, async (c) => {
  const staff = c.get('staff')!;

  // Get accessible stores for this staff
  let stores: { id: string; name: string; is_primary: number; line_friend_url: string | null }[] = [];
  let store = null;

  if (staff.role === 'system_admin') {
    // System admin can access all stores
    const result = await c.env.DB.prepare('SELECT id, name, line_friend_url FROM stores ORDER BY name').all<{
      id: string;
      name: string;
      line_friend_url: string | null;
    }>();
    stores = result.results.map((s) => ({ ...s, is_primary: 0 }));
    if (stores.length > 0) {
      store = stores[0];
    }
  } else {
    // Check staff_stores table first (multi-store support)
    const staffStores = await c.env.DB.prepare(
      `SELECT s.id, s.name, s.line_friend_url, ss.is_primary
       FROM staff_stores ss
       JOIN stores s ON s.id = ss.store_id
       WHERE ss.staff_id = ?
       ORDER BY ss.is_primary DESC, s.name`
    )
      .bind(staff.id)
      .all<{ id: string; name: string; line_friend_url: string | null; is_primary: number }>();

    if (staffStores.results.length > 0) {
      stores = staffStores.results;
      store = stores[0]; // Primary store or first one
    } else if (staff.store_id) {
      // Fallback to legacy store_id
      const legacyStore = await c.env.DB.prepare('SELECT id, name, line_friend_url FROM stores WHERE id = ?')
        .bind(staff.store_id)
        .first<{ id: string; name: string; line_friend_url: string | null }>();
      if (legacyStore) {
        stores = [{ ...legacyStore, is_primary: 1 }];
        store = legacyStore;
      }
    }
  }

  // Get pending invitations for this staff
  const pendingInvitations = await c.env.DB.prepare(
    `SELECT si.id, si.store_id, si.role, si.created_at,
            st.name as store_name,
            inv.name as invited_by_name
     FROM store_invitations si
     JOIN stores st ON st.id = si.store_id
     JOIN staff inv ON inv.id = si.invited_by
     WHERE si.staff_id = ? AND si.status = 'pending'
     ORDER BY si.created_at DESC`
  ).bind(staff.id).all();

  return c.json({
    staff: {
      id: staff.id,
      name: staff.name,
      nickname: staff.nickname,
      email: staff.email,
      role: staff.role,
      store_id: staff.store_id,
      avatar_url: staff.avatar_url,
      notify_push: staff.notify_push,
      notify_email: staff.notify_email,
      notify_line: staff.notify_line,
      staff_code: staff.staff_code,
      login_id: staff.login_id,
      minimo_name: staff.minimo_name,
      onboarding_completed: staff.onboarding_completed,
      owner_type: staff.owner_type,
      company_name: staff.company_name,
      company_postal_code: staff.company_postal_code,
      company_phone: staff.company_phone,
      company_address: staff.company_address,
      company_email: staff.company_email,
    },
    store, // Default/primary store (for backward compatibility)
    stores, // All accessible stores
    pending_invitations: pendingInvitations.results,
  });
});

// Update profile
authRoutes.put('/profile', staffAuth, async (c) => {
  const staff = c.get('staff')!;
  const body = await c.req.json<{
    name?: string;
    nickname?: string | null;
    avatar_url?: string;
    minimo_name?: string | null;
    notify_push?: boolean;
    notify_email?: boolean;
    notify_line?: boolean;
    owner_type?: 'individual' | 'company';
    company_name?: string | null;
    company_postal_code?: string | null;
    company_phone?: string | null;
    company_address?: string | null;
    company_email?: string | null;
  }>();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.nickname !== undefined) {
    updates.push('nickname = ?');
    values.push(body.nickname || null);
  }
  if (body.avatar_url !== undefined) {
    updates.push('avatar_url = ?');
    values.push(body.avatar_url);
  }
  if (body.minimo_name !== undefined) {
    updates.push('minimo_name = ?');
    values.push(body.minimo_name || null);
  }
  if (body.notify_push !== undefined) {
    updates.push('notify_push = ?');
    values.push(body.notify_push ? 1 : 0);
  }
  if (body.notify_email !== undefined) {
    updates.push('notify_email = ?');
    values.push(body.notify_email ? 1 : 0);
  }
  if (body.notify_line !== undefined) {
    updates.push('notify_line = ?');
    values.push(body.notify_line ? 1 : 0);
  }

  // Owner-only fields
  if (staff.role === 'owner') {
    if (body.owner_type !== undefined) {
      updates.push('owner_type = ?');
      values.push(body.owner_type);
    }
    if (body.company_name !== undefined) {
      updates.push('company_name = ?');
      values.push(body.company_name || null);
    }
    if (body.company_postal_code !== undefined) {
      updates.push('company_postal_code = ?');
      values.push(body.company_postal_code || null);
    }
    if (body.company_phone !== undefined) {
      updates.push('company_phone = ?');
      values.push(body.company_phone || null);
    }
    if (body.company_address !== undefined) {
      updates.push('company_address = ?');
      values.push(body.company_address || null);
    }
    if (body.company_email !== undefined) {
      updates.push('company_email = ?');
      values.push(body.company_email || null);
    }
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(staff.id);

  await c.env.DB.prepare(`UPDATE staff SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return c.json({ success: true });
});

// Register (self-registration)
authRoutes.post('/register', rateLimit(3, 60), async (c) => {
  const { name, email, password } = await c.req.json<{
    name: string; email: string; password: string;
  }>();

  if (!name || !email || !password) {
    return c.json({ error: '名前、メールアドレス、パスワードは必須です' }, 400);
  }

  if (password.length < 8) {
    return c.json({ error: 'パスワードは8文字以上にしてください' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM staff WHERE email = ?')
    .bind(email).first();
  if (existing) {
    return c.json({ error: 'このメールアドレスは既に登録されています' }, 400);
  }

  // Generate unique staff_code
  let staffCode = '';
  for (let i = 0; i < 10; i++) {
    staffCode = generateStaffCode();
    const codeExists = await c.env.DB.prepare('SELECT id FROM staff WHERE staff_code = ?')
      .bind(staffCode).first();
    if (!codeExists) break;
    if (i === 9) return c.json({ error: 'コードの生成に失敗しました。再度お試しください。' }, 500);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  const verificationToken = generateVerificationToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    `INSERT INTO staff (id, store_id, name, email, password_hash, role, staff_code, email_verified, verification_token, verification_token_expires_at)
     VALUES (?, NULL, ?, ?, ?, 'staff', ?, 0, ?, ?)`
  ).bind(id, name, email, passwordHash, staffCode, verificationToken, expiresAt).run();

  // Send verification email
  if (c.env.RESEND_API_KEY) {
    try {
      const emailService = new EmailService(c.env.RESEND_API_KEY, c.env.EMAIL_FROM);
      const verifyUrl = `${c.env.STAFF_APP_URL}/verify-email`;
      await emailService.sendVerificationEmail(email, name, verificationToken, verifyUrl);
    } catch (error) {
      console.error('Failed to send verification email:', error);
    }
  }

  return c.json({
    message: '登録が完了しました。メールをご確認ください。',
    staff_code: staffCode,
  }, 201);
});

// Verify email
authRoutes.post('/verify-email', async (c) => {
  const { token } = await c.req.json<{ token: string }>();

  if (!token) {
    return c.json({ error: 'トークンが必要です' }, 400);
  }

  const staff = await c.env.DB.prepare(
    'SELECT * FROM staff WHERE verification_token = ? AND email_verified = 0'
  ).bind(token).first<Staff>();

  if (!staff) {
    return c.json({ error: '無効なトークンです' }, 400);
  }

  if (staff.verification_token_expires_at && new Date(staff.verification_token_expires_at) < new Date()) {
    return c.json({ error: 'トークンの有効期限が切れています。認証メールを再送してください。' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE staff SET email_verified = 1, verification_token = NULL, verification_token_expires_at = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(staff.id).run();

  return c.json({ message: 'メールアドレスの認証が完了しました。ログインしてください。' });
});

// Resend verification email
authRoutes.post('/resend-verification', async (c) => {
  const { email } = await c.req.json<{ email: string }>();

  const staff = await c.env.DB.prepare(
    'SELECT * FROM staff WHERE email = ? AND email_verified = 0'
  ).bind(email).first<Staff>();

  if (!staff) {
    return c.json({ message: '認証メールを送信しました。' });
  }

  const verificationToken = generateVerificationToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await c.env.DB.prepare(
    `UPDATE staff SET verification_token = ?, verification_token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(verificationToken, expiresAt, staff.id).run();

  if (c.env.RESEND_API_KEY) {
    try {
      const emailService = new EmailService(c.env.RESEND_API_KEY, c.env.EMAIL_FROM);
      const verifyUrl = `${c.env.STAFF_APP_URL}/verify-email`;
      await emailService.sendVerificationEmail(staff.email, staff.name, verificationToken, verifyUrl);
    } catch (error) {
      console.error('Failed to send verification email:', error);
    }
  }

  return c.json({ message: '認証メールを送信しました。' });
});

// Request password reset
authRoutes.post('/forgot-password', rateLimit(3, 60), async (c) => {
  const { email } = await c.req.json<{ email: string }>();

  if (!email) {
    return c.json({ error: 'メールアドレスは必須です' }, 400);
  }

  // Always return success to prevent email enumeration
  const successMessage = '登録されているメールアドレスにパスワードリセットのリンクを送信しました。';

  const staff = await c.env.DB.prepare(
    'SELECT * FROM staff WHERE email = ? AND is_active = 1'
  ).bind(email).first<Staff>();

  if (!staff) {
    return c.json({ message: 'このメールアドレスは登録されていません。', registered: false });
  }

  const resetToken = generateVerificationToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  await c.env.DB.prepare(
    `UPDATE staff SET password_reset_token = ?, password_reset_token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(resetToken, expiresAt, staff.id).run();

  if (c.env.RESEND_API_KEY) {
    try {
      const emailService = new EmailService(c.env.RESEND_API_KEY, c.env.EMAIL_FROM);
      const resetUrl = `${c.env.STAFF_APP_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;
      await emailService.sendPasswordResetEmail(staff.email, staff.name, resetUrl);
    } catch (error) {
      console.error('Failed to send password reset email:', error);
    }
  }

  return c.json({ message: successMessage, registered: true });
});

// Reset password with token
authRoutes.post('/reset-password', rateLimit(3, 60), async (c) => {
  const { token, password } = await c.req.json<{ token: string; password: string }>();

  if (!token || !password) {
    return c.json({ error: 'トークンとパスワードは必須です' }, 400);
  }

  if (password.length < 8) {
    return c.json({ error: 'パスワードは8文字以上にしてください' }, 400);
  }

  const staff = await c.env.DB.prepare(
    'SELECT * FROM staff WHERE password_reset_token = ? AND is_active = 1'
  ).bind(token).first<Staff>();

  if (!staff) {
    return c.json({ error: '無効なトークンです' }, 400);
  }

  if (staff.password_reset_token_expires_at && new Date(staff.password_reset_token_expires_at) < new Date()) {
    return c.json({ error: 'トークンの有効期限が切れています。再度パスワードリセットを申請してください。' }, 400);
  }

  const passwordHash = await hashPassword(password);

  await c.env.DB.prepare(
    `UPDATE staff SET password_hash = ?, password_reset_token = NULL, password_reset_token_expires_at = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(passwordHash, staff.id).run();

  return c.json({ message: 'パスワードを変更しました。ログインしてください。' });
});

// Complete onboarding (owner only - first-time setup)
authRoutes.post('/complete-onboarding', staffAuth, async (c) => {
  const staff = c.get('staff')!;

  if (staff.role !== 'owner') {
    return c.json({ error: 'オーナーのみ利用できます' }, 403);
  }

  if (staff.onboarding_completed === 1) {
    return c.json({ error: '既にオンボーディング完了済みです' }, 400);
  }

  const body = await c.req.json<{
    owner_type: 'individual' | 'company';
    company_name?: string;
    company_postal_code?: string;
    company_phone?: string;
    company_address?: string;
    company_email?: string;
    store_name: string;
    store_postal_code?: string;
    store_address?: string;
    store_phone?: string;
    store_email?: string;
    email: string;
    password: string;
  }>();

  // Validate required fields
  if (!body.owner_type || !body.store_name || !body.email || !body.password) {
    return c.json({ error: '必須項目を入力してください' }, 400);
  }

  if (body.password.length < 8) {
    return c.json({ error: 'パスワードは8文字以上にしてください' }, 400);
  }

  if (body.owner_type === 'company' && !body.company_name) {
    return c.json({ error: '法人の場合は会社名を入力してください' }, 400);
  }

  // Check email uniqueness
  const existingEmail = await c.env.DB.prepare(
    'SELECT id FROM staff WHERE email = ? AND id != ?'
  ).bind(body.email, staff.id).first();
  if (existingEmail) {
    return c.json({ error: 'このメールアドレスは既に使用されています' }, 400);
  }

  const passwordHash = await hashPassword(body.password);

  // Generate staff_code for the owner
  let staffCode = '';
  for (let i = 0; i < 10; i++) {
    staffCode = generateStaffCode();
    const codeExists = await c.env.DB.prepare('SELECT id FROM staff WHERE staff_code = ?')
      .bind(staffCode).first();
    if (!codeExists) break;
    if (i === 9) return c.json({ error: 'コードの生成に失敗しました。再度お試しください。' }, 500);
  }

  // 1. Update staff record with company info, email, password
  await c.env.DB.prepare(
    `UPDATE staff SET
      email = ?, password_hash = ?, staff_code = ?,
      owner_type = ?, company_name = ?, company_postal_code = ?,
      company_phone = ?, company_address = ?, company_email = ?,
      must_change_password = 0, onboarding_completed = 1,
      email_verified = 1, updated_at = datetime('now')
    WHERE id = ?`
  ).bind(
    body.email, passwordHash, staffCode,
    body.owner_type,
    body.company_name || null, body.company_postal_code || null,
    body.company_phone || null, body.company_address || null, body.company_email || null,
    staff.id
  ).run();

  // 2. Create store
  const storeId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO stores (id, name, postal_code, address, phone, email)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    storeId, body.store_name,
    body.store_postal_code || null, body.store_address || null,
    body.store_phone || null, body.store_email || null
  ).run();

  // 3. Link owner to store
  const linkId = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO staff_stores (id, staff_id, store_id, is_primary, is_visible_to_customer) VALUES (?, ?, ?, 1, 1)'
  ).bind(linkId, staff.id, storeId).run();

  // 4. Update staff.store_id
  await c.env.DB.prepare(
    "UPDATE staff SET store_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(storeId, staff.id).run();

  // 5. Issue new token with updated store_id
  const token = await signToken(
    {
      sub: staff.id,
      type: 'staff',
      role: staff.role,
      storeId: storeId,
    },
    c
  );

  setCookie(c, 'auth_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain: c.env.COOKIE_DOMAIN || undefined,
    maxAge: 60 * 60 * 24 * 7,
  });

  return c.json({
    message: 'オンボーディングが完了しました',
    token,
    store: { id: storeId, name: body.store_name },
    staff_code: staffCode,
  });
});
