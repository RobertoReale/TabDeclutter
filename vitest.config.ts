import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // A green run with no tests at all would make the gate meaningless.
    passWithNoTests: false,
  },
});
