import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const rawPort = process.env.PORT || "5173";

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || "/";

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
  ],
  // aladin-lite ships pre-bundled (WASM + web-workers); exclude it from
  // Vite's esbuild pre-bundler so the assets are served as raw files.
  optimizeDeps: {
    exclude: ["aladin-lite"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: {
      "/api": {
        /**
         * The api-server, on this machine, unless told otherwise.
         *
         * Overridable because 127.0.0.1:8000 is not always the local
         * api-server. A VS Code Remote-SSH session forwards a remote port by
         * binding 127.0.0.1, and that bind takes precedence over the local
         * server's 0.0.0.0 / :: — so with a remote session open, this dev
         * server proxies every API call to the REMOTE deployment. The UI looks
         * local while showing another machine's database, which is a very
         * confusing way to spend an afternoon.
         *
         * Set API_PROXY_TARGET (e.g. http://[::1]:8000) to pin it.
         */
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
