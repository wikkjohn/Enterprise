"use client";

import { useEffect, useState } from "react";

/**
 * Timestamp in the viewer's locale/timezone. Renders UTC on the server and the
 * first client pass, then the local form after mount, so SSR and hydration
 * never disagree.
 */
export function LocalDate({ value, dateOnly = false }: { value: string | null | undefined; dateOnly?: boolean }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!value) return <>—</>;
  if (!mounted) return <time dateTime={value}>{value.slice(0, dateOnly ? 10 : 16).replace("T", " ")}{dateOnly ? "" : " UTC"}</time>;
  const d = new Date(value);
  return <time dateTime={value}>{dateOnly ? d.toLocaleDateString() : d.toLocaleString()}</time>;
}
