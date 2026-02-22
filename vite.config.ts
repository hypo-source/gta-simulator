import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,       // 0.0.0.0 로 바인딩
    port: 5173,
  }
});