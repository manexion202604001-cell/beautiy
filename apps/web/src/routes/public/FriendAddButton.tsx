import { Icon } from '../../components/ui';

/** 「友だち追加」: opens the LINE official account's 友だち追加URL (https://lin.ee/…) */
export function FriendAddButton({ url }: { url: string | null | undefined }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#06C755] bg-white text-[15px] font-semibold text-[#06C755] hover:bg-[#06C755]/5"
    >
      <Icon name="line" size={18} />
      友だち追加
    </a>
  );
}
