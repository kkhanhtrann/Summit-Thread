import { defineConfig } from 'vitest/config';

// Keep backend test discovery away from generated and installed files
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**']
  }
});
