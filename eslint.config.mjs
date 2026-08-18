import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/.workbuddy/**',
      '**/dist/**',
      '**/dist.*/**',
      '**/out/**',
      '**/out-*/**',
      '**/build/**',
      '**/output/**',
      '**/coverage/**',
      '**/.qoder/**',
      '**/audio-engine/build/**',
      '**/audio-engine/out/**',
      '**/packages/create-twilight-plugin/**/*.cjs'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/attributes-order': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*'],
              message: 'Renderer must not import Electron directly; use window.api.'
            },
            {
              group: ['node:*'],
              message: 'Renderer must not import Node built-ins directly.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/main/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@renderer/**', '@renderer'],
              message: 'Main process must not depend on renderer internals.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/preload/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['src/main/**', '../main/**'],
              message: 'Preload must not depend on main process internals.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/src/utils/**/*.{ts,tsx,vue}'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          message: 'Renderer utils must stay free of DOM and window.api access.',
          name: 'window'
        },
        {
          message: 'Renderer utils must stay free of DOM and window.api access.',
          name: 'document'
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='api']",
          message: 'Renderer utils must not touch window.api.'
        }
      ]
    }
  },
  {
    files: ['**/*.test.{ts,mts,js,mjs,cjs}', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-regex-spaces': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off'
    }
  },
  {
    files: [
      'src/renderer/src/utils/autoHideScrollbars.ts',
      'src/renderer/src/utils/animationFrameFallback.ts',
      'src/renderer/src/utils/liquidGlassDisplacement.ts',
      'src/renderer/src/utils/lyricViewportController.ts',
      'src/renderer/src/utils/themePreviewScheduler.ts',
      'src/renderer/src/utils/useSmoothedValue.ts',
      'src/renderer/src/utils/colorExtractor.ts'
    ],
    rules: {
      'no-restricted-globals': 'off'
    }
  },
  {
    files: ['src/preload/**/*.{ts,tsx}', 'resources/**/*.{js,mjs,cjs}'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off'
    }
  },
  {
    files: ['**/*.vue'],
    rules: {
      'no-undef': 'off'
    }
  },
  eslintConfigPrettier,
  {
    rules: {
      'prettier/prettier': 'off'
    }
  }
)
