import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "client", // папка клиента
  build: {
    outDir: "../dist", // собранные файлы
    emptyOutDir: true,
    minify: false,
    // terserOptions: {
    //   compress: true,
    //   mangle: true // обфускация имён
    // }
  },
  server: {
    port: 5173
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "client")
    }
  }
});
