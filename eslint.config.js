import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'playwright-report', 'test-results', 'spike/server/.data'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['spike/client/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['spike/server/**/*.ts', 'spike/tests/**/*.ts', 'spike/e2e/**/*.ts', '*.ts', '*.js'],
    languageOptions: { globals: globals.node },
  },
)
