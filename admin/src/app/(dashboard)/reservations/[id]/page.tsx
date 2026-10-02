import ReservationDetail from "./reservation-detail";

// Static export requires this for dynamic routes
export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ id: string }[]> {
  return [{ id: "placeholder" }];
}

export default async function ReservationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReservationDetail id={id} />;
}
