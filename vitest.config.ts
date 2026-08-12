import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// `server-only` throws on import under vitest's default resolution condition;
// point it at its react-server no-op stub file so server modules
// (env/config/db/registry) can be unit-tested directly.
const serverOnlyStub = fileURLToPath(
  new URL("./node_modules/server-only/empty.js", import.meta.url),
);

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
    alias: {
      "server-only": serverOnlyStub,
    },
  },
});
