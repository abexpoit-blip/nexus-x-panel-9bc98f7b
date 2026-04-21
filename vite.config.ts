import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // CRITICAL: react, react-dom, jsx-runtime, scheduler MUST stay in one chunk
          // (and load before anything that uses them). Splitting them causes
          // "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED" undefined errors.
          if (
            /[\\/]node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/.test(id) ||
            id.includes("react/jsx-runtime") ||
            id.includes("react/jsx-dev-runtime")
          ) {
            return "react-core";
          }
          if (id.includes("react-router") || id.includes("@remix-run")) return "react-router";
          if (id.includes("@tanstack")) return "query";
          if (id.includes("recharts") || id.includes("d3-") || id.includes("victory-vendor")) return "charts-vendor";
          if (id.includes("framer-motion")) return "motion";
          if (id.includes("@radix-ui") || id.includes("cmdk") || id.includes("vaul") || id.includes("input-otp")) return "ui-vendor";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("date-fns")) return "date-utils";
          return "vendor";
        },
      },
    },
  },
}));
