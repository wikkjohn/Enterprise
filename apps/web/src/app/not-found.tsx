import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="space-y-2 text-center">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="text-sm text-muted">It may not exist, or you may not have access to it.</p>
        <Link className="text-sm text-accent" href="/">Go home</Link>
      </div>
    </main>
  );
}
