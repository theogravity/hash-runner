import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HashRunnerConfigFile } from "../index";

const require = createRequire(import.meta.url);

const binPath = fileURLToPath(new URL("../../dist/cjs/bin/hash-runner.js", import.meta.url));
const repoConfigPath = fileURLToPath(new URL("../../hash-runner.config.js", import.meta.url));

function expectBuiltCli(): void {
  if (!existsSync(binPath)) {
    throw new Error(`Built CLI not found at ${binPath}. Run "pnpm run build" before "pnpm run test".`);
  }
}

describe("hash-runner CLI", () => {
  let tmpDir: string;
  let noopConfigPath: string;

  beforeAll(() => {
    // A throwaway config whose exec command is trivial, so exercising the flags
    // never runs the repository's real build.
    tmpDir = mkdtempSync(join(tmpdir(), "hash-runner-cli-"));
    noopConfigPath = join(tmpDir, "hash-runner.config.js");
    writeFileSync(
      noopConfigPath,
      'module.exports = { inputs: { includes: ["nonexistent-pattern/**/*.txt"] }, execOnChange: "true", hashFile: ".hashes.json" };\n',
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists every option in --help", () => {
    // Guards the parse-order bug where each option was registered after its own
    // parse() call, so --help (handled by the first parse) only ever showed --config.
    expectBuiltCli();

    const result = spawnSync(process.execPath, [binPath, "--help"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("-c, --config");
    expect(result.stdout).toContain("-f, --force");
    expect(result.stdout).toContain("-s, --silent");
  });

  it("accepts --force and --silent without an unknown-option error", () => {
    expectBuiltCli();

    const result = spawnSync(process.execPath, [binPath, "--config", noopConfigPath, "--force", "--silent"], {
      encoding: "utf8",
      cwd: tmpDir,
    });

    expect(result.stderr).not.toContain("unknown option");
    expect(result.status).toBe(0);
  });
});

describe("repository dogfood config", () => {
  it("is valid for the v4 config loader", () => {
    // The v4 rewrite changed the config format but left this repo's own
    // hash-runner.config.js in the v3 shape, which the shipped tool rejects.
    // This test keeps that from rotting again.
    const config = require(repoConfigPath) as HashRunnerConfigFile;

    expect(config.inputs).toBeDefined();
    expect(Array.isArray(config.inputs.includes)).toBe(true);
    expect(config.inputs.includes.length).toBeGreaterThan(0);
    expect(typeof config.execOnChange).toBe("string");
    expect(typeof config.hashFile).toBe("string");

    // v3 top-level keys must be gone, or loadConfig throws at runtime.
    expect("include" in config).toBe(false);
    expect("exclude" in config).toBe(false);
  });
});
