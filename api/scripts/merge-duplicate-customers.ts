/**
 * Merge duplicate customers by phone number.
 * - Keeps the record with the most reservations / most info (name_kana, etc.)
 * - Moves reservations, karutes, messages from duplicates to the kept record
 * - Appends store + staff info from deleted records to the kept record's memo
 * - Deletes duplicate records
 *
 * Usage: CLOUDFLARE_ACCOUNT_ID=... npx wrangler d1 execute salon-db --remote --file=scripts/merge-duplicate-customers.sql
 * Or run via: npx tsx scripts/merge-duplicate-customers.ts
 */

// This generates SQL statements to run via wrangler

async function main() {
  // We'll use wrangler CLI to query and execute
  const { execSync } = await import('child_process');

  const ACCOUNT_ID = 'CF_ACCOUNT_ID_PLACEHOLDER';
  const DB_NAME = 'salon-db';

  function query(sql: string): any[] {
    const escaped = sql.replace(/'/g, "'\\''");
    const cmd = `cd /Users/daisukeshimizu/dev/beeeapp/api && CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}' --json 2>/dev/null`;
    const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const parsed = JSON.parse(result);
    return parsed[0]?.results || [];
  }

  function execute(sql: string): void {
    const escaped = sql.replace(/'/g, "'\\''");
    const cmd = `cd /Users/daisukeshimizu/dev/beeeapp/api && CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}' 2>/dev/null`;
    execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  }

  // 1. Get all duplicate phone groups
  console.log('Finding duplicate phone groups...');
  const dupPhones = query(
    "SELECT phone, COUNT(*) as cnt FROM customers WHERE length(phone) > 5 GROUP BY phone HAVING cnt > 1 ORDER BY cnt DESC"
  );
  console.log(`Found ${dupPhones.length} duplicate groups`);

  let totalMerged = 0;
  let totalDeleted = 0;

  for (const { phone } of dupPhones) {
    // 2. Get all customers with this phone
    const customers = query(
      `SELECT c.id, c.name, c.name_kana, c.phone, c.email, c.staff_id, c.memo, c.store_id, c.gender, c.birthday, c.address, c.postal_code, c.occupation, st.name as store_name, s.name as staff_name, (SELECT COUNT(*) FROM reservations WHERE customer_id = c.id) as resv_count, (SELECT COUNT(*) FROM karutes WHERE customer_id = c.id) as karute_count FROM customers c LEFT JOIN stores st ON c.store_id = st.id LEFT JOIN staff s ON c.staff_id = s.id WHERE c.phone = '${phone}' ORDER BY resv_count DESC`
    );

    if (customers.length < 2) continue;

    // 3. Pick the best record to keep (most reservations, then most filled fields)
    const scored = customers.map((c: any) => ({
      ...c,
      score: (c.resv_count || 0) * 100 +
        (c.name_kana ? 10 : 0) +
        (c.email ? 5 : 0) +
        (c.gender ? 3 : 0) +
        (c.birthday ? 3 : 0) +
        (c.address ? 3 : 0) +
        (c.karute_count || 0) * 10
    }));
    scored.sort((a: any, b: any) => b.score - a.score);

    const keep = scored[0];
    const toDelete = scored.slice(1);

    // 4. Build memo addition from deleted records
    const memoAdditions: string[] = [];
    for (const dup of toDelete) {
      const parts: string[] = [];
      if (dup.store_name) parts.push(dup.store_name);
      if (dup.staff_name) parts.push(`担当:${dup.staff_name}`);
      if (dup.name !== keep.name) parts.push(`名前:${dup.name}`);
      if (parts.length > 0) {
        memoAdditions.push(parts.join(' / '));
      }
    }

    const deleteIds = toDelete.map((d: any) => d.id);
    const deleteIdsSql = deleteIds.map((id: string) => `'${id}'`).join(',');

    console.log(`\nMerging phone ${phone}: keep=${keep.name} (${keep.store_name}), delete ${deleteIds.length} records`);

    // 5. Move reservations
    execute(`UPDATE reservations SET customer_id = '${keep.id}' WHERE customer_id IN (${deleteIdsSql})`);

    // 6. Move karutes
    execute(`UPDATE karutes SET customer_id = '${keep.id}' WHERE customer_id IN (${deleteIdsSql})`);

    // 7. Move messages
    execute(`UPDATE messages SET customer_id = '${keep.id}' WHERE customer_id IN (${deleteIdsSql})`);

    // 8. Update memo on kept record
    if (memoAdditions.length > 0) {
      const newMemo = memoAdditions.join('\n');
      const existingMemo = keep.memo || '';
      const fullMemo = existingMemo ? `${existingMemo}\n${newMemo}` : newMemo;
      const escapedMemo = fullMemo.replace(/'/g, "''");
      execute(`UPDATE customers SET memo = '${escapedMemo}' WHERE id = '${keep.id}'`);
    }

    // 9. Fill in missing fields on kept record from deleted records
    const updates: string[] = [];
    for (const dup of toDelete) {
      if (!keep.name_kana && dup.name_kana) { keep.name_kana = dup.name_kana; updates.push(`name_kana = '${dup.name_kana.replace(/'/g, "''")}'`); }
      if (!keep.email && dup.email) { keep.email = dup.email; updates.push(`email = '${dup.email}'`); }
      if (!keep.gender && dup.gender) { keep.gender = dup.gender; updates.push(`gender = '${dup.gender}'`); }
      if (!keep.birthday && dup.birthday) { keep.birthday = dup.birthday; updates.push(`birthday = '${dup.birthday}'`); }
      if (!keep.address && dup.address) { keep.address = dup.address; updates.push(`address = '${dup.address.replace(/'/g, "''")}'`); }
      if (!keep.postal_code && dup.postal_code) { keep.postal_code = dup.postal_code; updates.push(`postal_code = '${dup.postal_code}'`); }
      if (!keep.staff_id && dup.staff_id) { keep.staff_id = dup.staff_id; updates.push(`staff_id = '${dup.staff_id}'`); }
    }
    if (updates.length > 0) {
      execute(`UPDATE customers SET ${updates.join(', ')} WHERE id = '${keep.id}'`);
    }

    // 10. Delete duplicates
    execute(`DELETE FROM customers WHERE id IN (${deleteIdsSql})`);

    totalDeleted += deleteIds.length;
    totalMerged++;
  }

  console.log(`\nDone! Merged ${totalMerged} groups, deleted ${totalDeleted} duplicate records.`);
}

main().catch(console.error);
