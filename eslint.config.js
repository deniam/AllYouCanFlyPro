import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "src/data/routes.js",
      "src/libs/**",
      "assets/**"
    ]
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        chrome: "readonly",
        browser: "readonly"
      }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      "no-constant-condition": ["error", { "checkLoops": false }]
    }
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.mjs", "vitest.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node
      }
    }
  }
];
