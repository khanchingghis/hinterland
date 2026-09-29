import type { Metadata } from "next";
import { Fraunces, Outfit } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
});

export const metadata: Metadata = {
  title: "Hinterland — distance from a road",
  description:
    "A map that classifies land by straight-line distance to the nearest road, from a planetary grid down to a single view.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${outfit.variable} ${fraunces.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">
        <TooltipProvider delay={250}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
