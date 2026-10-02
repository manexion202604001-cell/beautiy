import { execSync } from 'child_process';

const ACCOUNT_ID = 'CF_ACCOUNT_ID_PLACEHOLDER';
const DB_NAME = 'salon-db';
const API_DIR = '/Users/daisukeshimizu/dev/beeeapp/api';

function query(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  const cmd = `cd ${API_DIR} && CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}' --json 2>/dev/null`;
  const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const parsed = JSON.parse(result);
  return parsed[0]?.results || [];
}

function execute(sql) {
  const escaped = sql.replace(/'/g, "'\\''");
  const cmd = `cd ${API_DIR} && CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} npx wrangler d1 execute ${DB_NAME} --remote --command '${escaped}' 2>/dev/null`;
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
  const customers = query(
    `SELECT c.id, c.name, c.name_kana, c.phone, c.email, c.staff_id, c.memo, c.store_id, c.gender, c.birthday, c.address, c.postal_code, c.occupation, st.name as store_name, s.name as staff_name, (SELECT COUNT(*) FROM reservations WHERE customer_id = c.id) as resv_count, (SELECT COUNT(*) FROM karutes WHERE customer_id = c.id) as karute_count FROM customers c LEFT JOIN stores st ON c.store_id = st.id LEFT JOIN staff s ON c.staff_id = s.id WHERE c.phone = '${phone}' ORDER BY resv_count DESC`
  );

  if (customers.length < 2) continue;

  // Pick the best record: most reservations, then most info
  const scored = customers.map(c => ({
    ...c,
    score: (c.resv_count || 0) * 100 +
      (c.name_kana ? 10 : 0) +
      (c.email ? 5 : 0) +
      (c.gender ? 3 : 0) +
      (c.birthday ? 3 : 0) +
      (c.address ? 3 : 0) +
      (c.karute_count || 0) * 10
  }));
  scored.sort((a, b) => b.score - a.score);

  const keep = scored[0];
  const toDelete = scored.slice(1);

  // Build memo from deleted records (store + staff info)
  const memoAdditions = [];
  for (const dup of toDelete) {
    const parts = [];
    if (dup.store_name) parts.push(dup.store_name);
    if (dup.staff_name) parts.push(`担当:${dup.staff_name}`);
    if (dup.name !== keep.name) parts.push(`名前:${dup.name}`);
    if (parts.length > 0) {
      memoAdditions.push(parts.join(' / '));
    }
  }

  const deleteIds = toDelete.map(d => d.id);
  const deleteIdsSql = deleteIds.map(id => `'${id}'`).join(',');

  console.log(`Merge ${phone}: keep=${keep.name} (${keep.store_name}), delete ${deleteIds.length}`);

  // Move reservations, karutes, messages
  execute(`UPDATE reservations SET customer_id = '${keep.id}' WHERE customer_id IN (${deleteIdsSql})`);
  execute(`UPDATE karutes SET customer_id = '${keep.id}' WHERE customer_id IN (${deleteIdsSql})`);
  execute(`UPDATE messages SET customer_id = '${keep.id}' WHERE customer_id IN (${deleteIdsSql})`);

  // Update memo
  if (memoAdditions.length > 0) {
    const newMemo = memoAdditions.join('\\n');
    const existingMemo = keep.memo || '';
    const fullMemo = existingMemo ? `${existingMemo}\\n${newMemo}` : newMemo;
    const escapedMemo = fullMemo.replace(/'/g, "''");
    execute(`UPDATE customers SET memo = '${escapedMemo}' WHERE id = '${keep.id}'`);
  }

  // Fill missing fields from duplicates
  const updates = [];
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

  // Delete duplicates
  execute(`DELETE FROM customers WHERE id IN (${deleteIdsSql})`);

  totalDeleted += deleteIds.length;
  totalMerged++;
}

console.log(`\nDone! Merged ${totalMerged} groups, deleted ${totalDeleted} duplicate records.`);
