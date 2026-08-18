import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'src/server/**/*.ts',
      'src/persistence/**/*.ts',
      'src/domain/**/*.ts',
      'src/contracts/**/*.ts',
      'tests/**/*.ts',
      '*.ts',
      '*.js',
    ],
    languageOptions: { globals: globals.node },
  },
)
