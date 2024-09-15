import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { glob } from "glob";
import { type Mock, type MockedFunction, beforeEach, describe, expect, it, vi } from "vitest";
import { hashRunner } from "..";

vi.mock("cosmiconfig", () => ({
  cosmiconfig: vi.fn(() => ({
    search: vi.fn(),
    load: vi.fn(),
  })),
}));

vi.mock("fs/promises");
vi.mock("child_process");
vi.mock("glob");

vi.mock("node:child_process", () => ({
  exec: vi.fn(
    (command: string, options: any, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, "success", "");
    },
  ),
}));

const mockedReadFile = fs.readFile as MockedFunction<typeof fs.readFile>;
const mockedWriteFile = fs.writeFile as MockedFunction<typeof fs.writeFile>;
const mockedGlob = glob as MockedFunction<typeof glob>;

describe("hashRunner", () => {
  const mockConfigPath = path.resolve(__dirname, "..", ".hash-runner.json");
  const mockConfigDir = path.dirname(mockConfigPath);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should run execOnChange and update the hash file if hashes mismatch", async () => {
    const mockConfig = {
      include: ["src/**/*.js"],
      exclude: ["node_modules/**", "src/**/__tests__/**"],
      execOnChange: 'echo "Files changed"',
      hashFile: ".hashes.json",
    };

    (cosmiconfig as Mock).mockReturnValue({
      search: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
      load: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
    });

    const fileContent = "const a = 1;";
    const oldHashes = { "test.ts": "oldhash" };
    const currentHashes = {
      "test.ts": createHash("sha256").update(fileContent).digest("hex"),
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(oldHashes));
    mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
    mockedReadFile.mockResolvedValue(fileContent);

    await hashRunner();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(mockConfig.execOnChange, { cwd: mockConfigDir }, expect.any(Function));
    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(mockConfigDir, mockConfig.hashFile),
      JSON.stringify(currentHashes, null, 2),
    );
  });

  it("should not run execOnChange if hashes match", async () => {
    const mockConfig = {
      include: ["**/*.js"],
      exclude: ["node_modules/**"],
      execOnChange: 'echo "Files changed"',
      hashFile: ".hashes.json",
    };

    (cosmiconfig as Mock).mockReturnValue({
      search: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
      load: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
    });

    const fileContent = "const a = 1;";
    const currentHashes = {
      "file.js": createHash("sha256").update(fileContent).digest("hex"),
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(currentHashes));

    mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
    mockedReadFile.mockResolvedValue(fileContent);

    await hashRunner();

    expect(exec).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("should bypass hash checks and run execOnChange in CI mode", async () => {
    const mockConfig = {
      include: ["**/*.js"],
      exclude: ["node_modules/**"],
      execOnChange: 'echo "Files changed"',
      hashFile: ".hashes.json",
    };

    (cosmiconfig as Mock).mockReturnValue({
      search: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
      load: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
    });

    const originalCI = process.env.CI;
    process.env.CI = "true";

    try {
      const fileContent = "const a = 1;";
      const currentHashes = {
        "file.js": createHash("sha256").update(fileContent).digest("hex"),
      };

      mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
      mockedReadFile.mockResolvedValue(fileContent);

      await hashRunner();

      expect(exec).toHaveBeenCalledWith(mockConfig.execOnChange, { cwd: mockConfigDir }, expect.any(Function));
      expect(exec).toHaveBeenCalledTimes(1); // Ensure it was called once
    } finally {
      process.env.CI = originalCI;
    }
  });

  it("should throw an error if config file is not found or is empty", async () => {
    const mockConfig = {
      include: ["**/*.js"],
      exclude: ["node_modules/**"],
      execOnChange: 'echo "Files changed"',
      hashFile: ".hashes.json",
    };

    (cosmiconfig as Mock).mockReturnValue({
      search: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
      load: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
    });

    (cosmiconfig as Mock).mockReturnValue({
      search: vi.fn(() => Promise.resolve(null)),
    });

    await expect(hashRunner()).rejects.toThrow("Config file not found or is empty");
  });
});
