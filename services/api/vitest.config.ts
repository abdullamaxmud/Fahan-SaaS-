import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each file starts its own in-memory replica set; give the first binary download time.
    hookTimeout: 180_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
