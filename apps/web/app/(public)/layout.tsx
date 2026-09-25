// Customer-facing pages (no staff session). Each page renders its own header with the shop name.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="public">{children}</div>;
}
