import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    // Klassische Skripte ohne Build, die der Browser unveraendert laedt (`public/erscheinungsbild.js`).
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
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
