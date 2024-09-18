import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";
import { lilconfig } from "lilconfig";
import { type Mock, type MockedFunction, beforeEach, describe, expect, it, vi } from "vitest";
import { HashRunner } from "../index";

vi.mock("lilconfig", () => ({
  lilconfig: vi.fn(() => ({
    search: vi.fn(),
    load: vi.fn(),
  })),
}));

vi.mock("fs/promises");
vi.mock("child_process");
vi.mock("glob");

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: any) => {
    const mockProcess = {
      on: (event: string, callback: (code: number) => void) => {
        if (event === "close") {
          callback(0); // simulate process exiting with code 0
        }
      },
    };
    return mockProcess as any;
  }),
}));

const mockedReadFile = fs.readFile as MockedFunction<typeof fs.readFile>;
const mockedWriteFile = fs.writeFile as MockedFunction<typeof fs.writeFile>;
const mockedGlob = glob as MockedFunction<typeof glob>;

describe("HashRunner", () => {
  const mockConfigPath = path.resolve(__dirname, "..", ".hash-runner.json");
  const mockConfigDir = path.dirname(mockConfigPath);
  const getMockConfig = (overrides = {}) => ({
    include: ["**/*.js"],
    exclude: ["node_modules/**"],
    execOnChange: 'echo "Files changed"',
    hashFile: ".hashes.json",
    ...overrides,
  });

  const setupMocks = (config: Record<string, any>) => {
    (lilconfig as Mock).mockReturnValue({
      search: vi.fn(() => Promise.resolve({ config, filepath: mockConfigPath })),
      load: vi.fn(() => Promise.resolve({ config, filepath: mockConfigPath })),
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createHashRunner = (configPath?: string) => {
    return new HashRunner(configPath);
  };

  it("should run execOnChange and update the hash file if hashes mismatch", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent = "const a = 1;";
    const oldHashes = { "test.ts": "oldhash" };
    const currentHashes = {
      "test.ts": createHash("sha256").update(fileContent).digest("hex"),
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(oldHashes));
    mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, { cwd: mockConfigDir, shell: true, stdio: "inherit" });

    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(mockConfigDir, mockConfig.hashFile),
      JSON.stringify(currentHashes, null, 2),
    );
  });

  it("should not run execOnChange if hashes match", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent = "const a = 1;";
    const currentHashes = {
      "file.js": createHash("sha256").update(fileContent).digest("hex"),
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(currentHashes));
    mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    expect(spawn).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("should bypass hash checks and run execOnChange in CI mode", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const originalCI = process.env.CI;
    process.env.CI = "true";

    try {
      const fileContent = "const a = 1;";
      const currentHashes = {
        "file.js": createHash("sha256").update(fileContent).digest("hex"),
      };

      mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
      mockedReadFile.mockResolvedValue(fileContent);

      const runner = createHashRunner();
      await runner.run();

      expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, {
        cwd: mockConfigDir,
        shell: true,
        stdio: "inherit",
      });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      process.env.CI = originalCI;
    }
  });

  it("should throw an error if config file is not found or is empty", async () => {
    (lilconfig as Mock).mockReturnValue({
      search: vi.fn(() => Promise.resolve(null)),
    });

    const runner = createHashRunner();
    await expect(runner.run()).rejects.toThrow("[hash-runner] Config file not found or is empty");
  });

  it("should run execOnChange and create the hash file if it does not exist", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent = "const a = 1;";
    const currentHashes = {
      "file.js": createHash("sha256").update(fileContent).digest("hex"),
    };

    mockedReadFile.mockRejectedValueOnce(new Error("File not found"));
    mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, { cwd: mockConfigDir, shell: true, stdio: "inherit" });

    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(mockConfigDir, mockConfig.hashFile),
      JSON.stringify(currentHashes, null, 2),
    );
  });

  it("should run execOnChange and update the hash file if hashes length mismatch", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent1 = "const a = 1;";
    const fileContent2 = "const b = 2;";

    const oldHashes = {
      "file1.js": createHash("sha256").update(fileContent1).digest("hex"),
    };
    const currentHashes = {
      "file1.js": createHash("sha256").update(fileContent1).digest("hex"),
      "file2.js": createHash("sha256").update(fileContent2).digest("hex"),
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(oldHashes));
    mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
    mockedReadFile.mockResolvedValueOnce(fileContent1).mockResolvedValueOnce(fileContent2);

    const runner = createHashRunner();
    await runner.run();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, { cwd: mockConfigDir, shell: true, stdio: "inherit" });

    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(mockConfigDir, mockConfig.hashFile),
      JSON.stringify(currentHashes, null, 2),
    );
  });

  it("should run execOnChange and update the hash file if hashes mismatch using chunked comparisons", async () => {
    const mockConfig = getMockConfig({ parallelizeComparisonsChunkSize: 3 });
    setupMocks(mockConfig);

    const fileContents = Array.from({ length: 10 }, (_, i) => `const a${i} = ${i};`);
    const oldHashes = Object.fromEntries(
      fileContents.map((content, i) => [`file${i}.js`, createHash("sha256").update(`old${content}`).digest("hex")]),
    );
    const currentHashes = Object.fromEntries(
      fileContents.map((content, i) => [`file${i}.js`, createHash("sha256").update(content).digest("hex")]),
    );

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(oldHashes));
    mockedGlob.mockResolvedValue(fileContents.map((_, i) => path.join(mockConfigDir, `file${i}.js`)) as any);
    for (const content of fileContents) {
      mockedReadFile.mockResolvedValueOnce(content);
    }

    const runner = createHashRunner();
    await runner.run();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, { cwd: mockConfigDir, shell: true, stdio: "inherit" });

    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(mockConfigDir, mockConfig.hashFile),
      JSON.stringify(currentHashes, null, 2),
    );
  });

  it("should not run execOnChange if hashes match using chunked comparisons with chunk size 2", async () => {
    const mockConfig = getMockConfig({ parallelizeComparisonsChunkSize: 2 });
    setupMocks(mockConfig);

    const fileContents = Array.from({ length: 10 }, (_, i) => `const a${i} = ${i};`);
    const currentHashes = Object.fromEntries(
      fileContents.map((content, i) => [`file${i}.js`, createHash("sha256").update(content).digest("hex")]),
    );

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(currentHashes));
    mockedGlob.mockResolvedValue(fileContents.map((_, i) => path.join(mockConfigDir, `file${i}.js`)) as any);
    for (const content of fileContents) {
      mockedReadFile.mockResolvedValueOnce(content);
    }

    const runner = createHashRunner();
    await runner.run();

    expect(spawn).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});
