import type { AppProps } from "next/app";
import { useRouter } from "next/router";
import "@/styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();

  return (
    <div key={router.asPath} className="page-fade">
      <Component {...pageProps} />
    </div>
  );
}
