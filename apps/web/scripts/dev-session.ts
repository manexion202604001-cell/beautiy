/* Dev helper: print a session cookie for a user so pages can be fetched with curl.
   Usage: npx tsx --env-file-if-exists=../../.env scripts/dev-session.ts owner@demo.salon
   Then:  curl -b "salonos_session=<token>" http://localhost:3000/dashboard */
import { randomToken, sha256 } from '@salonos/core/crypto';
import { prisma } from '../lib/server/db';

async function main() {
  const email = process.argv[2] ?? 'owner@demo.salon';
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const token = randomToken();
  await prisma.session.create({ data: { tokenHash: sha256(token), userId: user.id, organizationId: user.memberships[0].organizationId, expiresAt: new Date(Date.now() + 86400000) } });
  console.log(`salonos_session=${token}`);
}
main().finally(() => prisma.$disconnect());
