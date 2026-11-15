export default [{
  files: ["app/static/**/*.js"],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "script",
    globals: {
      window: "readonly",
      document: "readonly",
      fetch: "readonly",
      setTimeout: "readonly",
    },
  },
  rules: {
    "no-unused-vars": ["error", { args: "none" }],
  },
}];
