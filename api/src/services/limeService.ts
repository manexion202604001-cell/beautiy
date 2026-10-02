// Service to import menus from LiME via the salonboard-worker


interface LimeMenuItem {
  name: string;
  category: string;
  price: number;
  duration: number;
  image_url?: string;
  description?: string;
  coupon_type?: 'new' | 'repeat' | 'all';
  sort_order?: number;
}

interface LimeMenuResult {
  success: boolean;
  menus: LimeMenuItem[];
  message: string;
  debug?: { url: string; htmlSnippet: string };
}

export async function importLimeMenusToDb(
  db: D1Database,
  storeId: string,
  menus: LimeMenuItem[]
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  for (const menu of menus) {
    // Ensure category is never empty
    if (!menu.category || !menu.category.trim()) {
      menu.category = 'HPBクーポン';
    }

    // Check if menu with same name already exists in this store
    const existing = await db.prepare(
      'SELECT id FROM menus WHERE store_id = ? AND name = ?'
    ).bind(storeId, menu.name).first();

    if (existing) {
      skipped++;
      continue;
    }

    // Ensure category exists
    const existingCategory = await db.prepare(
      'SELECT id FROM menu_categories WHERE store_id = ? AND name = ?'
    ).bind(storeId, menu.category).first();

    if (!existingCategory) {
      await db.prepare(
        `INSERT INTO menu_categories (id, store_id, name, color, sort_order)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        storeId,
        menu.category,
        '#6B7280',
        0
      ).run();
    }

    // Create the menu
    await db.prepare(
      `INSERT INTO menus (id, store_id, category, name, description, duration, price, image_url, sort_order, coupon_type, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      storeId,
      menu.category,
      menu.name,
      menu.description || null,
      menu.duration,
      menu.price,
      menu.image_url || null,
      menu.sort_order ?? 0,
      menu.coupon_type || null,
      1
    ).run();

    created++;
  }

  return { created, skipped };
}

// Staff import from LiME JSON

interface LimeStaffItem {
  name: string;
  role: string;
  avatar_url?: string;
}

export async function importLimeStaffToDb(
  db: D1Database,
  storeId: string,
  staffList: LimeStaffItem[]
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  // Dummy password hash for imported staff (SHA-256 of 'lime-import')
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode('lime-import'));
  const dummyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  for (const s of staffList) {
    if (!s.name) {
      skipped++;
      continue;
    }

    // Check if staff with same name already exists in this store
    const existing = await db.prepare(
      'SELECT id FROM staff WHERE store_id = ? AND name = ?'
    ).bind(storeId, s.name).first();

    if (existing) {
      skipped++;
      continue;
    }

    // Map LiME role to app role
    const role = s.role === 'ディレクター' ? 'manager' : 'staff';

    const staffId = crypto.randomUUID();

    await db.prepare(
      `INSERT INTO staff (id, store_id, name, email, password_hash, role, avatar_url, is_active)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 1)`
    ).bind(
      staffId,
      storeId,
      s.name,
      dummyHash,
      role,
      s.avatar_url || null
    ).run();

    // Create staff_stores entry
    await db.prepare(
      `INSERT INTO staff_stores (id, staff_id, store_id, is_primary)
       VALUES (?, ?, ?, 1)`
    ).bind(crypto.randomUUID(), staffId, storeId).run();

    created++;
  }

  return { created, skipped };
}

// Customer import from LiME JSON

interface LimeCustomerItem {
  staffName: string;
  customerName: string;
  nameKana?: string;
  gender?: string;
  birthday?: string;
  origin?: string;
  occupation?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  address?: string;
}

type ExistingCustomer = {
  id: string; name: string; name_kana: string | null; phone: string | null;
  email: string | null; gender: string | null; birthday: string | null;
  occupation: string | null; postal_code: string | null; address: string | null;
  memo: string | null; staff_id: string | null;
};

export async function importLimeCustomersToDb(
  db: D1Database,
  storeId: string,
  customers: LimeCustomerItem[]
): Promise<{ created: number; updated: number; skipped: number; staffNotFound: string[] }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const staffNotFound: string[] = [];

  // Collect unique names and phones from this batch for targeted lookup
  const batchNames: string[] = [];
  const batchPhones: string[] = [];
  for (const c of customers) {
    if (c.customerName) batchNames.push(c.customerName.trim());
    if (c.phone?.trim()) batchPhones.push(c.phone.trim());
  }

  // Fetch only matching existing customers (not all customers)
  const byName = new Map<string, ExistingCustomer>();
  const byPhone = new Map<string, ExistingCustomer>();

  // Query in chunks of 50 names/phones to stay within SQL limits
  const cols = 'id, name, name_kana, phone, email, gender, birthday, occupation, postal_code, address, memo, staff_id';
  for (let i = 0; i < batchNames.length; i += 50) {
    const chunk = batchNames.slice(i, i + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT ${cols} FROM customers WHERE store_id = ? AND name IN (${placeholders})`
    ).bind(storeId, ...chunk).all<ExistingCustomer>();
    for (const r of rows.results) {
      byName.set(r.name, r);
      if (r.phone) byPhone.set(r.phone, r);
    }
  }
  for (let i = 0; i < batchPhones.length; i += 50) {
    const chunk = batchPhones.slice(i, i + 50);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT ${cols} FROM customers WHERE store_id = ? AND phone IN (${placeholders})`
    ).bind(storeId, ...chunk).all<ExistingCustomer>();
    for (const r of rows.results) {
      if (!byName.has(r.name)) byName.set(r.name, r);
      if (r.phone && !byPhone.has(r.phone)) byPhone.set(r.phone, r);
    }
  }

  // Pre-fetch staff for this store
  const staffRecords = await db.prepare(
    'SELECT s.id, s.name, s.lime_name FROM staff s INNER JOIN staff_stores ss ON s.id = ss.staff_id WHERE ss.store_id = ?'
  ).bind(storeId).all<{ id: string; name: string; lime_name: string | null }>();

  const staffMap = new Map(staffRecords.results.map(s => [s.name, s.id]));
  const limeNameMap = new Map(
    staffRecords.results.filter(s => s.lime_name).map(s => [s.lime_name!, s.id])
  );

  const statements: D1PreparedStatement[] = [];
  const seenNames = new Set<string>();

  for (const c of customers) {
    if (!c.customerName) {
      skipped++;
      continue;
    }

    const customerName = c.customerName.trim();
    const phone = c.phone?.trim() || null;

    if (seenNames.has(customerName)) {
      skipped++;
      continue;
    }

    // Look up staff
    let staffId: string | null = null;
    if (c.staffName) {
      const trimmedName = c.staffName.trim();
      staffId = staffMap.get(trimmedName) || limeNameMap.get(trimmedName) || null;
      if (!staffId && !staffNotFound.includes(trimmedName)) {
        staffNotFound.push(trimmedName);
      }
    }

    let gender: string | null = null;
    if (c.gender === '女') gender = 'female';
    else if (c.gender === '男') gender = 'male';

    const birthday = (c.birthday && c.birthday !== '秘密') ? c.birthday : null;
    const origin = c.origin === 'スタッフ集客' ? 'staff' : 'store';
    const memo = (!staffId && c.staffName) ? `元担当: ${c.staffName.trim()}` : null;
    const nameKana = c.nameKana || null;
    const occupation = c.occupation || null;
    const postalCode = c.postalCode || null;
    const email = c.email?.trim() || null;
    const address = c.address?.trim() || null;

    // Match by phone first, then by name
    const existing = (phone && byPhone.get(phone)) || byName.get(customerName);

    if (existing) {
      const updates: string[] = [];
      const values: (string | null)[] = [];

      if (nameKana && !existing.name_kana) { updates.push('name_kana = ?'); values.push(nameKana); }
      if (gender && !existing.gender) { updates.push('gender = ?'); values.push(gender); }
      if (birthday && !existing.birthday) { updates.push('birthday = ?'); values.push(birthday); }
      if (occupation && !existing.occupation) { updates.push('occupation = ?'); values.push(occupation); }
      if (postalCode && !existing.postal_code) { updates.push('postal_code = ?'); values.push(postalCode); }
      if (phone && !existing.phone) { updates.push('phone = ?'); values.push(phone); }
      if (email && !existing.email) { updates.push('email = ?'); values.push(email); }
      if (address && !existing.address) { updates.push('address = ?'); values.push(address); }
      if (staffId && !existing.staff_id) { updates.push('staff_id = ?'); values.push(staffId); }
      if (memo && !existing.memo) { updates.push('memo = ?'); values.push(memo); }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        statements.push(
          db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).bind(...values, existing.id)
        );
        updated++;
      } else {
        skipped++;
      }
    } else {
      statements.push(
        db.prepare(
          `INSERT INTO customers (id, store_id, staff_id, name, name_kana, gender, birthday, occupation, postal_code, phone, email, address, memo, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(), storeId, staffId, customerName,
          nameKana, gender, birthday, occupation, postalCode,
          phone, email, address, memo, origin
        )
      );
      created++;
    }

    seenNames.add(customerName);
  }

  // Execute in batches of 50 (D1 batch limit)
  for (let i = 0; i < statements.length; i += 50) {
    const batch = statements.slice(i, i + 50);
    await db.batch(batch);
  }

  return { created, updated, skipped, staffNotFound };
}
