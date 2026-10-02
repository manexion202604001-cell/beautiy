import EditReservationForm from "./edit-form";

export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ id: string }[]> {
  return [{ id: "placeholder" }];
}

export default function EditReservationPage() {
  return <EditReservationForm />;
}
