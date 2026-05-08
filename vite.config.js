import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/epub-fixer/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
  },
});
