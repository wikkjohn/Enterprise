import { AcceptInviteForm } from "@/components/auth/forms";
export const metadata = { title: "Accept invitation" };
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  return <AcceptInviteForm token={(await params).token} />;
}
