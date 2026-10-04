import { ToastProvider } from "@eaop/design-system";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <main className="grid min-h-dvh place-items-center bg-background px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-md bg-accent text-xs font-semibold text-accent-fg" aria-hidden>
              AI
            </div>
            <span className="text-sm font-semibold">Enterprise AI Operating Platform</span>
          </div>
          <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">{children}</div>
        </div>
      </main>
    </ToastProvider>
  );
}
