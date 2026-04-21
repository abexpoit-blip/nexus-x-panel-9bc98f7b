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
          if (id.includes("react-dom") || id.includes("react-router-dom") || id.includes("@remix-run") || id.includes("scheduler")) return "react-router";
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
