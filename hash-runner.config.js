module.exports = {
  inputs: {
    includes: ["src/**/*.ts"],
    excludes: ["dist/**"],
  },
  outputs: {
    includes: ["dist/**"],
  },
  execOnChange: "pnpm run build",
  hashFile: ".hashes.json",
};
