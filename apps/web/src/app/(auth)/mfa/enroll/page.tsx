import { MfaEnrollForm } from "@/components/auth/forms";
export const metadata = { title: "Set up two-step verification" };
export default function Page() {
  return <MfaEnrollForm required />;
}
