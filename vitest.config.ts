import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src')
        }
    },
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        // Leave CPU capacity for password hashing and application processes.
        // Unbounded workers can make correct credential tests time out.
        maxWorkers: 4,
        minWorkers: 1
    }
});
