import KaruteDetail from "./karute-detail";

// Static export requires this for dynamic routes
export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ id: string }[]> {
  // Return a placeholder - actual content is loaded client-side
  return [{ id: "placeholder" }];
}

export default async function KaruteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <KaruteDetail id={id} />;
}
