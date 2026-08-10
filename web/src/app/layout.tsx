import type { Metadata } from "next";
import "./globals.css";

// 老师收藏或分享本地应用时，浏览器会使用下面的标题和说明。
export const metadata: Metadata = {
  title: "Ngee Ann Polytechnic ICT Timetabling",
  description: "Department course timetabling workspace",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // 这个共享外壳设置文档语言，并建立占满浏览器高度的页面画布。
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
