"use client";

import { ErrorState } from "@eaop/design-system";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState title="Something went wrong" message="The page could not be loaded. Try again; if it keeps happening, contact your administrator with the reference below." requestId={error.digest} retry={reset} />;
}
