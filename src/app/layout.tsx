import type { Metadata } from "next";
import { sans as inter, mono as jb } from "./fonts";
import { Shell } from "@/components/shell";
import { CurrencyProvider } from "@/lib/currency";
import "./globals.css";

export const metadata: Metadata = {
  title: "Meridian",
  description: "Systematic multi-strategy capital — asset markets and event markets",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${jb.variable} h-full`}>
      <body className="min-h-full">
        <CurrencyProvider>
          <Shell>{children}</Shell>
        </CurrencyProvider>
      </body>
    </html>
  );
}
