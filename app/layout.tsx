import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TRACE/CORE — FLOP-ready Identity & Contribution Studio",
  description: "Create a portable Ed25519 DID, join signed Technocore chat, and export a verifiable pre-testnet FLOP ecosystem contribution trail.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
