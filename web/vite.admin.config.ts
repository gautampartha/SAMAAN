import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Authority console build: served by the API at /admin (see api/main.py), so assets live under /admin/.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist-admin',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: { admin: 'admin.html' },
      output: { manualChunks: { maplibre: ['maplibre-gl'] } },
    },
  },
});
