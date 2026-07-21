import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Shell } from "@/components/shell";
import { CurrencyProvider } from "@/lib/currency";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jb = JetBrains_Mono({
  variable: "--font-jb",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Meridian — autonomous trading",
  description: "Autonomous crypto trading platform",
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
