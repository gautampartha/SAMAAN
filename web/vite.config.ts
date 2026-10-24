import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    // maplibre-gl alone is ~1 MB minified; it is split into its own chunk above.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Keep the (large) map engine in its own cacheable chunk.
        manualChunks: { maplibre: ['maplibre-gl'] },
      },
    },
  },
});
