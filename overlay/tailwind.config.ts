import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Mirror the WOLFEE-MVP palette where it matters for the overlay.
        // Full theme tokens land when settings UI ships in Sub-prompt 6.
        copilot: {
          accent: "#22d3ee", // cyan-400
          glow: "rgba(34, 211, 238, 0.25)",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
