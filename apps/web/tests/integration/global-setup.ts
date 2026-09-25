import { execSync } from 'node:child_process';
import path from 'node:path';

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://salonos:salonos@localhost:5432/salonos_test';
  execSync(`npx prisma db push --force-reset --skip-generate --schema ${path.resolve(__dirname, '../../../../packages/db/prisma/schema.prisma')}`, {
    env: { ...process.env, DATABASE_URL: url, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' }, stdio: 'pipe',
  });
}
