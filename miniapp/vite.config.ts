import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API runs on :8787; in production both are served from one origin.
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { target: 'es2020', sourcemap: false },
});
