import MenuEdit from "./menu-edit";

export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ id: string }[]> {
  return [{ id: "placeholder" }];
}

export default async function MenuEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MenuEdit id={id} />;
}
