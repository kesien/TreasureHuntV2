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
        background_color: "#1c1917",
        theme_color: "#c2410c",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // Az API válaszait a szolgáltatás nem gyorsítótárazza (a kliens saját pillanatképet tart IndexedDB-ben)
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /tile/.test(url.hostname) || /\/\d+\/\d+\/\d+\.(png|pbf)$/.test(url.pathname),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "map-tiles", expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
  server: { proxy: { "/api": "http://localhost:3000" } },
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
});
