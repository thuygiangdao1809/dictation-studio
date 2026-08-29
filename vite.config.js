import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative base so the built app works from any subpath (e.g. GitHub Pages
  // project sites at https://<user>.github.io/<repo>/). If you deploy to a
  // custom domain or the root of a host, you can change this back to "/".
  base: "./",
});
