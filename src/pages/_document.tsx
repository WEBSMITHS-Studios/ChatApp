import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta name="theme-color" content="#07111f" />
        <style>{`
          html {
            background: #07111f;
            color-scheme: dark;
          }
          body {
            margin: 0;
            background:
              radial-gradient(circle at top, rgba(116, 208, 255, 0.16), transparent 34%),
              radial-gradient(circle at 82% 18%, rgba(127, 255, 210, 0.12), transparent 26%),
              linear-gradient(180deg, #08111d 0%, #091019 38%, #05080f 100%);
          }
        `}</style>
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
