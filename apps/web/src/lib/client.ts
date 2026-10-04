"use client";

/** Typed error thrown by apiFetch with the platform's error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)eaop_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : "";
}

/** Client-side JSON fetch to /api/v1 with CSRF header and envelope unwrapping. */
export async function apiFetch<T = unknown>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": csrfToken() } : {}),
      ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { data?: T; error?: { code: string; message: string; details?: Record<string, unknown>; requestId?: string } }) : {};
  if (!res.ok || json.error) {
    if (res.status === 401 && json.error?.code === "UNAUTHENTICATED" && !path.startsWith("/auth/")) window.location.assign("/login");
    throw new ApiError(res.status, json.error?.code ?? "INTERNAL", json.error?.message ?? "Request failed", json.error?.details, json.error?.requestId);
  }
  return json.data as T;
}
