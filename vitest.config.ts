import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // Die Integrationstests teilen sich eine Datenbank und raeumen sie zwischen den Faellen auf; parallele
    // Dateien wuerden sich gegenseitig die Zeilen unter den Fuessen wegloeschen.
    fileParallelism: false,
    // Die Integrationstests sprechen eine echte Datenbank an; der Standardwert von 5s ist dafuer knapp.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
