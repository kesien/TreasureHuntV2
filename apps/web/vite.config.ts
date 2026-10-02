import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Kincsvadászat",
        short_name: "Kincsvadászat",
        description: "Szezonális közösségi esemény: állomások, check-in, fotók.",
        lang: "hu",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#120d1f",
        theme_color: "#120d1f",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,svg,png}"], // a betűk is előtöltődnek: offline is a téma szerinti megjelenés
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // Az API válaszait a szolgáltatás nem gyorsítótárazza (a kliens saját pillanatképet tart IndexedDB-ben).
        // A Google Maps csempéit sem: a feltételeik nem engedik a gyorsítótárazást, offline a lista a tartalék.
      },
    }),
  ],
  server: { proxy: { "/api": "http://localhost:3000" } },
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
});
