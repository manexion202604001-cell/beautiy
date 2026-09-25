'use client';
import { useRouter } from 'next/navigation';
import { addToCart } from '../../store/[shopSlug]/_components/cart';

export function RecAddButton({ slug, token, productIds, label, className = 'btn sm', disabled }: { slug: string; token: string; productIds: string[]; label: string; className?: string; disabled?: boolean }) {
  const router = useRouter();
  return (
    <button type="button" className={className} disabled={disabled} onClick={() => { for (const id of productIds) addToCart(slug, id, 1, token); router.push(`/store/${slug}/cart`); }}>
      {label}
    </button>
  );
}
