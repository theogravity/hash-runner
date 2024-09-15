module.exports = {
  include: ["src/**/*.ts"],
  exclude: ["dist/**"],
  execOnChange: "pnpm run build",
  hashFile: ".hashes.json",
};
