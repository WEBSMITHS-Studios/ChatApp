import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}", "./pages/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#090b10",
          900: "#10131b",
          800: "#171b25",
          700: "#232838"
        }
      }
    }
  },
  plugins: []
};

export default config;
