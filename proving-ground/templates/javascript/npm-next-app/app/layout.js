export const metadata = {
  title: 'pg-next-app',
  description: 'Proving-ground Next.js fixture'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
