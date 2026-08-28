import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '暗格 · 在线剧本杀',
  description: '支持用户名身份、剧本与角色选择、私密搜证和公开线索大看板的多人在线剧本杀平台。',
};

export const viewport: Viewport = {
  themeColor: '#120d1b',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
