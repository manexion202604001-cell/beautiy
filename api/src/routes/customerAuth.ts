import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { Bindings, Variables, Customer } from '../types';
import { signToken, customerAuth, hashPassword, verifyPassword, rehashIfLegacy } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { sanitizeCustomer } from '../utils/sanitize';

export const customerAuthRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Login with email/password - rate limited: 5 attempts per 60s
customerAuthRoutes.post('/login', rateLimit(5, 60), async (c) => {
  const { email, password, store_id } = await c.req.json<{
    email: string;
    password: string;
    store_id: string;
  }>();

  if (!email || !password || !store_id) {
    return c.json({ error: 'Email, password, and store_id are required' }, 400);
  }

  const customer = await c.env.DB.prepare(
    `SELECT * FROM customers
     WHERE email = ? AND store_id = ? AND password_hash IS NOT NULL
     AND (auth_method = 'email' OR auth_method = 'both')`
  )
    .bind(email, store_id)
    .first<Customer>();

  if (!customer) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const isValidPassword = await verifyPassword(password, customer.password_hash!);
  if (!isValidPassword) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // Transparently migrate legacy SHA-256 hashes to PBKDF2
  c.executionCtx.waitUntil(rehashIfLegacy(c.env.DB, 'customers', customer.id, password, customer.password_hash!));

  const token = await signToken(
    {
      sub: customer.id,
      type: 'customer',
      storeId: customer.store_id,
    },
    c
  );

  setCookie(c, 'customer_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain: '.example.com',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return c.json({
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    },
    token,
  });
});

// Register with email/password
customerAuthRoutes.post('/register', rateLimit(3, 60), async (c) => {
  const body = await c.req.json<{
    store_id: string;
    name: string;
    email: string;
    password: string;
    phone?: string;
  }>();

  if (!body.store_id || !body.name || !body.email || !body.password) {
    return c.json({ error: 'Store ID, name, email, and password are required' }, 400);
  }

  // Check if email already exists for this store
  const existing = await c.env.DB.prepare(
    'SELECT id FROM customers WHERE email = ? AND store_id = ?'
  )
    .bind(body.email, body.store_id)
    .first();

  if (existing) {
    return c.json({ error: 'Email already registered' }, 400);
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(body.password);

  await c.env.DB.prepare(
    `INSERT INTO customers (id, store_id, name, email, password_hash, auth_method, phone)
     VALUES (?, ?, ?, ?, ?, 'email', ?)`
  )
    .bind(id, body.store_id, body.name, body.email, passwordHash, body.phone || null)
    .run();

  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(id)
    .first<Customer>();

  const token = await signToken(
    {
      sub: customer!.id,
      type: 'customer',
      storeId: customer!.store_id,
    },
    c
  );

  setCookie(c, 'customer_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain: '.example.com',
    maxAge: 60 * 60 * 24 * 30,
  });

  return c.json(
    {
      customer: {
        id: customer!.id,
        name: customer!.name,
        email: customer!.email,
        phone: customer!.phone,
      },
      token,
    },
    201
  );
});

// LINE Login - redirect to LINE authorization
customerAuthRoutes.get('/line', async (c) => {
  const storeId = c.req.query('store_id');

  if (!storeId) {
    return c.json({ error: 'Store ID is required' }, 400);
  }

  // Get store LINE config
  const store = await c.env.DB.prepare('SELECT line_channel_id FROM stores WHERE id = ?')
    .bind(storeId)
    .first<{ line_channel_id: string | null }>();

  if (!store?.line_channel_id) {
    return c.json({ error: 'LINE login not configured for this store' }, 400);
  }

  const state = btoa(JSON.stringify({ store_id: storeId }));
  const redirectUri = `${c.env.CUSTOMER_APP_URL}/auth/line/callback`;

  const lineAuthUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  lineAuthUrl.searchParams.set('response_type', 'code');
  lineAuthUrl.searchParams.set('client_id', store.line_channel_id);
  lineAuthUrl.searchParams.set('redirect_uri', redirectUri);
  lineAuthUrl.searchParams.set('state', state);
  lineAuthUrl.searchParams.set('scope', 'profile openid');

  return c.json({ url: lineAuthUrl.toString() });
});

// LINE Login callback
customerAuthRoutes.post('/line/callback', async (c) => {
  const { code, state } = await c.req.json<{ code: string; state: string }>();

  if (!code || !state) {
    return c.json({ error: 'Code and state are required' }, 400);
  }

  let storeId: string;
  try {
    const stateData = JSON.parse(atob(state));
    storeId = stateData.store_id;
  } catch {
    return c.json({ error: 'Invalid state' }, 400);
  }

  // Get store LINE config
  const store = await c.env.DB.prepare(
    'SELECT line_channel_id, line_channel_secret FROM stores WHERE id = ?'
  )
    .bind(storeId)
    .first<{ line_channel_id: string | null; line_channel_secret: string | null }>();

  if (!store?.line_channel_id || !store?.line_channel_secret) {
    return c.json({ error: 'LINE login not configured' }, 400);
  }

  // Exchange code for token
  const redirectUri = `${c.env.CUSTOMER_APP_URL}/auth/line/callback`;

  const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: store.line_channel_id,
      client_secret: store.line_channel_secret,
    }),
  });

  if (!tokenResponse.ok) {
    return c.json({ error: 'Failed to exchange code' }, 400);
  }

  const tokenData = await tokenResponse.json<{ access_token: string; id_token: string }>();

  // Get LINE profile
  const profileResponse = await fetch('https://api.line.me/v2/profile', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
    },
  });

  if (!profileResponse.ok) {
    return c.json({ error: 'Failed to get profile' }, 400);
  }

  const profile = await profileResponse.json<{
    userId: string;
    displayName: string;
    pictureUrl?: string;
  }>();

  // Check if LINE user exists
  const existingLine = await c.env.DB.prepare(
    `SELECT cl.*, c.* FROM customer_line cl
     JOIN customers c ON cl.customer_id = c.id
     WHERE cl.line_user_id = ? AND c.store_id = ?`
  )
    .bind(profile.userId, storeId)
    .first<Customer & { line_user_id: string }>();

  let customer: Customer;

  if (existingLine) {
    // Update LINE info
    await c.env.DB.prepare(
      "UPDATE customer_line SET display_name = ?, picture_url = ?, updated_at = datetime('now') WHERE line_user_id = ?"
    )
      .bind(profile.displayName, profile.pictureUrl || null, profile.userId)
      .run();

    customer = existingLine;
  } else {
    // Create new customer
    const customerId = crypto.randomUUID();

    await c.env.DB.prepare(
      `INSERT INTO customers (id, store_id, name, auth_method)
       VALUES (?, ?, ?, 'line')`
    )
      .bind(customerId, storeId, profile.displayName)
      .run();

    // Create LINE link with pending registration
    await c.env.DB.prepare(
      `INSERT INTO customer_line (id, customer_id, store_id, line_user_id, display_name, picture_url, registration_status)
       VALUES (?, ?, (SELECT store_id FROM customers WHERE id = ?), ?, ?, ?, 'pending_name')`
    )
      .bind(
        crypto.randomUUID(),
        customerId,
        customerId,
        profile.userId,
        profile.displayName,
        profile.pictureUrl || null
      )
      .run();

    customer = (await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
      .bind(customerId)
      .first<Customer>())!;
  }

  const token = await signToken(
    {
      sub: customer.id,
      type: 'customer',
      storeId: customer.store_id,
    },
    c
  );

  setCookie(c, 'customer_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain: '.example.com',
    maxAge: 60 * 60 * 24 * 30,
  });

  // Get LINE info for response
  const lineInfo = await c.env.DB.prepare(
    'SELECT display_name, picture_url FROM customer_line WHERE customer_id = ?'
  )
    .bind(customer.id)
    .first();

  return c.json({
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    },
    line: lineInfo,
    token,
    isNewUser: !existingLine,
  });
});

// LIFF auto-login (LINE in-app browser)
customerAuthRoutes.post('/liff', async (c) => {
  const { liff_access_token, store_id } = await c.req.json<{
    liff_access_token: string;
    store_id: string;
  }>();

  if (!liff_access_token || !store_id) {
    return c.json({ error: 'liff_access_token and store_id are required' }, 400);
  }

  // Get store LINE config
  const store = await c.env.DB.prepare(
    'SELECT line_liff_id FROM stores WHERE id = ?'
  )
    .bind(store_id)
    .first<{ line_liff_id: string | null }>();

  if (!store?.line_liff_id) {
    return c.json({ error: 'LIFF not configured for this store' }, 400);
  }

  // Verify the LIFF access token with LINE
  // Note: LIFF tokens come from a LINE Login channel (separate from Messaging API channel)
  const verifyRes = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(liff_access_token)}`
  );
  if (!verifyRes.ok) {
    return c.json({ error: 'Invalid LIFF access token' }, 401);
  }
  const verifyData = await verifyRes.json<{ expires_in: number }>();

  if (verifyData.expires_in <= 0) {
    return c.json({ error: 'LIFF access token expired' }, 401);
  }

  // Get LINE profile
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${liff_access_token}` },
  });
  if (!profileRes.ok) {
    return c.json({ error: 'Failed to get LINE profile' }, 400);
  }
  const profile = await profileRes.json<{
    userId: string;
    displayName: string;
    pictureUrl?: string;
  }>();

  // Check if LINE user exists
  const existingLine = await c.env.DB.prepare(
    `SELECT cl.*, c.* FROM customer_line cl
     JOIN customers c ON cl.customer_id = c.id
     WHERE cl.line_user_id = ? AND c.store_id = ?`
  )
    .bind(profile.userId, store_id)
    .first<Customer & { line_user_id: string }>();

  let customer: Customer;

  if (existingLine) {
    // Update LINE info
    await c.env.DB.prepare(
      "UPDATE customer_line SET display_name = ?, picture_url = ?, updated_at = datetime('now') WHERE line_user_id = ?"
    )
      .bind(profile.displayName, profile.pictureUrl || null, profile.userId)
      .run();

    customer = existingLine;
  } else {
    // Create new customer
    const customerId = crypto.randomUUID();

    await c.env.DB.prepare(
      `INSERT INTO customers (id, store_id, name, auth_method)
       VALUES (?, ?, ?, 'line')`
    )
      .bind(customerId, store_id, profile.displayName)
      .run();

    // Create LINE link with pending registration
    await c.env.DB.prepare(
      `INSERT INTO customer_line (id, customer_id, store_id, line_user_id, display_name, picture_url, registration_status)
       VALUES (?, ?, (SELECT store_id FROM customers WHERE id = ?), ?, ?, ?, 'pending_name')`
    )
      .bind(
        crypto.randomUUID(),
        customerId,
        customerId,
        profile.userId,
        profile.displayName,
        profile.pictureUrl || null
      )
      .run();

    customer = (await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
      .bind(customerId)
      .first<Customer>())!;
  }

  const token = await signToken(
    {
      sub: customer.id,
      type: 'customer',
      storeId: customer.store_id,
    },
    c
  );

  setCookie(c, 'customer_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain: '.example.com',
    maxAge: 60 * 60 * 24 * 30,
  });

  // Get LINE info for response
  const lineInfo = await c.env.DB.prepare(
    'SELECT display_name, picture_url FROM customer_line WHERE customer_id = ?'
  )
    .bind(customer.id)
    .first();

  return c.json({
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    },
    line: lineInfo,
    token,
    isNewUser: !existingLine,
  });
});

// Logout
customerAuthRoutes.post('/logout', (c) => {
  deleteCookie(c, 'customer_token', { path: '/' });
  return c.json({ success: true });
});

// Phone-based customer matching (for new LIFF users)
customerAuthRoutes.post('/phone-match', customerAuth, async (c) => {
  const currentCustomer = c.get('customer')!;
  const { phone } = await c.req.json<{ phone: string }>();

  if (!phone) {
    return c.json({ error: 'Phone number is required' }, 400);
  }

  // Find existing customer with same phone in same store
  const existingCustomer = await c.env.DB.prepare(
    'SELECT * FROM customers WHERE store_id = ? AND phone = ? AND id != ? LIMIT 1'
  )
    .bind(currentCustomer.store_id, phone, currentCustomer.id)
    .first<Customer>();

  if (!existingCustomer) {
    // No match — just update phone on the current (new) customer
    await c.env.DB.prepare(
      "UPDATE customers SET phone = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(phone, currentCustomer.id)
      .run();

    return c.json({
      matched: false,
      customer: sanitizeCustomer({ ...currentCustomer, phone } as unknown as Record<string, unknown>),
    });
  }

  // Check if existing customer already has a LINE link FOR THIS STORE. Links are per store,
  // so a link at another store must not block matching here.
  const existingLine = await c.env.DB.prepare(
    'SELECT id FROM customer_line WHERE customer_id = ? AND store_id = ?'
  )
    .bind(existingCustomer.id, currentCustomer.store_id)
    .first();

  if (existingLine) {
    return c.json(
      { error: 'This phone number is linked to another LINE account' },
      409
    );
  }

  // Move this store's customer_line from the new customer to the existing customer
  await c.env.DB.prepare(
    "UPDATE customer_line SET customer_id = ?, updated_at = datetime('now') WHERE customer_id = ? AND store_id = ?"
  )
    .bind(existingCustomer.id, currentCustomer.id, currentCustomer.store_id)
    .run();

  // Update existing customer auth_method
  const newAuthMethod =
    existingCustomer.auth_method === 'email' ? 'both' : 'line';
  await c.env.DB.prepare(
    "UPDATE customers SET auth_method = ?, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(newAuthMethod, existingCustomer.id)
    .run();

  // Migrate any data from new customer to existing customer
  await c.env.DB.prepare(
    'UPDATE reservations SET customer_id = ? WHERE customer_id = ?'
  )
    .bind(existingCustomer.id, currentCustomer.id)
    .run();

  await c.env.DB.prepare(
    'UPDATE messages SET customer_id = ? WHERE customer_id = ?'
  )
    .bind(existingCustomer.id, currentCustomer.id)
    .run();

  await c.env.DB.prepare(
    'UPDATE karutes SET customer_id = ? WHERE customer_id = ?'
  )
    .bind(existingCustomer.id, currentCustomer.id)
    .run();

  // Delete the new (duplicate) customer
  await c.env.DB.prepare('DELETE FROM customers WHERE id = ?')
    .bind(currentCustomer.id)
    .run();

  // Issue new JWT for the existing customer
  const token = await signToken(
    {
      sub: existingCustomer.id,
      type: 'customer',
      storeId: existingCustomer.store_id,
    },
    c
  );

  setCookie(c, 'customer_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    domain: '.example.com',
    maxAge: 60 * 60 * 24 * 30,
  });

  return c.json({
    matched: true,
    customer: {
      id: existingCustomer.id,
      name: existingCustomer.name,
      email: existingCustomer.email,
      phone: existingCustomer.phone,
    },
    token,
  });
});

// Get current customer
customerAuthRoutes.get('/me', customerAuth, async (c) => {
  const customer = c.get('customer')!;

  // Get LINE info
  const lineInfo = await c.env.DB.prepare(
    'SELECT display_name, picture_url, registration_status FROM customer_line WHERE customer_id = ?'
  )
    .bind(customer.id)
    .first();

  // Get store info
  const store = await c.env.DB.prepare('SELECT id, name FROM stores WHERE id = ?')
    .bind(customer.store_id)
    .first();

  return c.json({
    customer: {
      id: customer.id,
      name: customer.name,
      name_kana: customer.name_kana,
      email: customer.email,
      phone: customer.phone,
      gender: customer.gender,
      birthday: customer.birthday,
      auth_method: customer.auth_method,
    },
    line: lineInfo,
    store,
  });
});
