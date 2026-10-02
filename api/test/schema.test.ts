// Schema consistency: every SQL statement in src/ must prepare against schema.sql.
// Catches columns/tables that the code uses but the schema (or a migration) never defines.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..');
const schema = readFileSync(join(root, 'src/db/schema.sql'), 'utf8');
const seed = readFileSync(join(root, 'src/db/seed.sql'), 'utf8');

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listTs(p) : p.endsWith('.ts') ? [p] : [];
  });
}

// String/template literals that look like SQL. `${...}` interpolations are dropped
// (they build optional clauses) and `IN (${placeholders})` becomes `IN (?)`.
function extractSql(): { where: string; sql: string }[] {
  const out: { where: string; sql: string }[] = [];
  const literal = /`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'/gs;
  for (const file of listTs(join(root, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(literal)) {
      const raw = m[1] ?? m[2];
      if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(raw)) continue;
      const sql = raw
        .replace(/IN\s*\(\$\{[^}]*\}\)/g, 'IN (?)')
        .replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
      const line = src.slice(0, m.index).split('\n').length;
      out.push({ where: `${relative(root, file)}:${line}`, sql });
    }
  }
  return out;
}

describe('schema.sql', () => {
  it('loads, and can be applied twice (idempotent)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    db.exec(schema);
  });

  it('accepts seed.sql with foreign keys enforced', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(schema);
    db.exec(seed);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('defines every table and column referenced by SQL in src/', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    const statements = extractSql();
    expect(statements.length).toBeGreaterThan(500);

    const missing: string[] = [];
    for (const { where, sql } of statements) {
      try {
        db.prepare(sql);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Only schema drift is reported; fragments of dynamically built SQL may not parse on their own
        if (/no such (column|table)/.test(msg)) missing.push(`${where}: ${msg}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
