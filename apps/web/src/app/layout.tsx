import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Enterprise AI Operating Platform", template: "%s · Enterprise AI Platform" },
  description: "Shared enterprise core for AI workflow, governance, security, integration, knowledge and operations.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-fg antialiased">{children}</body>
    </html>
  );
}
