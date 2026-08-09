import type { Metadata } from "next";
import "./globals.css";

// Browser title and description used when staff bookmark or share the local app.
export const metadata: Metadata = {
  title: "Ngee Ann Polytechnic ICT Timetabling",
  description: "Department course timetabling workspace",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // This shared shell establishes the document language and full-height page canvas.
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
