import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  define: { __BUILD_BACKEND_ORIGIN__: JSON.stringify("http://127.0.0.1:8080") },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000
  }
});
