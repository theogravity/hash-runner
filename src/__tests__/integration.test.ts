import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HashFileV2, HashRunner } from "../index";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// The unit suite mocks glob, fs, and spawn wholesale. These tests run the real
// thing against a temporary directory so dependency behavior changes (glob 13's
// matching, for one) and the core content-not-mtime contract have a witness.
describe("HashRunner against a real filesystem", () => {
  let tmpDir: string;
  let configPath: string;
  let markerPath: string;
  let hashFilePath: string;
  let inputPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hash-runner-int-"));
    markerPath = join(tmpDir, "ran.marker");
    hashFilePath = join(tmpDir, ".hashes.json");
    configPath = join(tmpDir, "hash-runner.config.js");
    inputPath = join(tmpDir, "a.txt");

    // The exec command touches a marker file, so tests can observe whether
    // the command ran without parsing console output.
    writeFileSync(
      configPath,
      `module.exports = {
  inputs: { includes: ["**/*.txt"] },
  execOnChange: "touch '${markerPath}'",
  hashFile: ".hashes.json",
};\n`,
    );
    writeFileSync(inputPath, "hello");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readHashFile(): HashFileV2 {
    return JSON.parse(readFileSync(hashFilePath, "utf8")) as HashFileV2;
  }

  it("runs the command and writes hashes on a cold run", async () => {
    await new HashRunner(configPath).run();

    expect(existsSync(markerPath)).toBe(true);
    const hashes = readHashFile();
    expect(hashes.hashSchemaVersion).toBe("2");
    expect(hashes.inputs["a.txt"]).toBe(sha256("hello"));
  });

  it("does not re-run when only the modification time changed", async () => {
    rmSync(markerPath, { force: true });
    const now = new Date();
    utimesSync(inputPath, now, now);

    await new HashRunner(configPath).run();

    expect(existsSync(markerPath)).toBe(false);
  });

  it("re-runs when content changes", async () => {
    rmSync(markerPath, { force: true });
    writeFileSync(inputPath, "changed");

    await new HashRunner(configPath).run();

    expect(existsSync(markerPath)).toBe(true);
    expect(readHashFile().inputs["a.txt"]).toBe(sha256("changed"));
  });
});
