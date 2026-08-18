import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true, // expose on LAN so phones/tablets can test
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
