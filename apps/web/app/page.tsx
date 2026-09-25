import { redirect } from 'next/navigation';
import { getStaffContext } from '@/lib/server/session';

export default async function Home() {
  const ctx = await getStaffContext();
  redirect(ctx ? '/dashboard' : '/login');
}
