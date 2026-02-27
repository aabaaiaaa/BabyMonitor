import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,

  // App modules — browser context, ES modules
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // CDN-loaded libraries (loaded via <script> in HTML, not npm)
        Peer:    'readonly', // PeerJS
        QRCode:  'readonly', // qrcode.js
        jsQR:    'readonly', // jsQR
      },
    },
    rules: {
      // Unused vars/args/catch-bindings prefixed with _ are intentional
      'no-unused-vars': ['warn', {
        varsIgnorePattern:       '^_',
        argsIgnorePattern:       '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-console': 'off',
    },
  },

  // Service worker — uses ServiceWorkerGlobalScope, not window
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
    rules: {
      'no-console': 'off',
    },
  },
];
