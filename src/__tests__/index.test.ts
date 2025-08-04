import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";
import { lilconfig } from "lilconfig";
import { beforeEach, describe, expect, it, type Mock, type MockedFunction, vi } from "vitest";
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
  spawn: vi.fn((_command: string, _args: string[], _options: any) => {
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
    inputs: {
      includes: ["**/*.js"],
      excludes: [],
    },
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
    const oldHashFile = {
      hashSchemaVersion: "2" as const,
      inputs: { "test.ts": "oldhash" },
    };
    const currentHashes = {
      "test.ts": createHash("sha256").update(fileContent).digest("hex"),
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(oldHashFile));
    mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, { cwd: mockConfigDir, shell: true, stdio: "inherit" });

    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(mockConfigDir, mockConfig.hashFile),
      JSON.stringify(
        {
          hashSchemaVersion: "2",
          inputs: currentHashes,
          outputs: undefined,
        },
        null,
        2,
      ),
    );
  });

  it("should not run execOnChange if hashes match", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent = "const a = 1;";
    const currentHashes = {
      "file.js": createHash("sha256").update(fileContent).digest("hex"),
    };
    const hashFile = {
      hashSchemaVersion: "2" as const,
      inputs: currentHashes,
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(hashFile));
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
      JSON.stringify(
        {
          hashSchemaVersion: "2",
          inputs: currentHashes,
          outputs: undefined,
        },
        null,
        2,
      ),
    );
  });

  it("should run execOnChange and update the hash file if hashes length mismatch", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent1 = "const a = 1;";
    const fileContent2 = "const b = 2;";

    const oldHashFile = {
      hashSchemaVersion: "2" as const,
      inputs: {
        "file1.js": createHash("sha256").update(fileContent1).digest("hex"),
      },
    };
    const currentHashes = {
      "file1.js": createHash("sha256").update(fileContent1).digest("hex"),
      "file2.js": createHash("sha256").update(fileContent2).digest("hex"),
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(oldHashFile));
    mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
    mockedReadFile.mockResolvedValueOnce(fileContent1).mockResolvedValueOnce(fileContent2);

    const runner = createHashRunner();
    await runner.run();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, { cwd: mockConfigDir, shell: true, stdio: "inherit" });

    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(mockConfigDir, mockConfig.hashFile),
      JSON.stringify(
        {
          hashSchemaVersion: "2",
          inputs: currentHashes,
          outputs: undefined,
        },
        null,
        2,
      ),
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

    const oldHashFile = {
      hashSchemaVersion: "2" as const,
      inputs: oldHashes,
    };

    mockedReadFile.mockResolvedValueOnce(JSON.stringify(oldHashFile));
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
      JSON.stringify(
        {
          hashSchemaVersion: "2",
          inputs: currentHashes,
          outputs: undefined,
        },
        null,
        2,
      ),
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

  it("should automatically exclude the hash file from processing", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent = "const a = 1;";
    const currentHashes = {
      "file.js": createHash("sha256").update(fileContent).digest("hex"),
    };

    // Mock that the hash file exists and has the same content as current hashes
    mockedReadFile.mockResolvedValueOnce(JSON.stringify(currentHashes));

    // Mock glob to return only the regular file (since hash file should be excluded)
    const includedFiles = [path.join(mockConfigDir, "file.js")];
    mockedGlob.mockResolvedValue(includedFiles as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    // Verify that glob was called with the correct exclude patterns
    expect(mockedGlob).toHaveBeenCalledWith(
      mockConfig.inputs.includes,
      expect.objectContaining({
        ignore: expect.arrayContaining([
          ...(mockConfig.inputs.excludes || []),
          mockConfig.hashFile, // The hash file should be in the exclude patterns
        ]),
      }),
    );

    // Verify that the hash file was excluded from glob results
    expect(mockedGlob).toHaveBeenCalledWith(
      mockConfig.inputs.includes,
      expect.objectContaining({
        ignore: expect.arrayContaining([mockConfig.hashFile]),
      }),
    );
  });

  it("should automatically exclude the configuration file from processing", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent = "const a = 1;";
    const currentHashes = {
      "file.js": createHash("sha256").update(fileContent).digest("hex"),
    };

    // Mock that the hash file exists and has the same content as current hashes
    mockedReadFile.mockResolvedValueOnce(JSON.stringify(currentHashes));

    // Mock glob to return only the regular file (since config file should be excluded)
    const includedFiles = [path.join(mockConfigDir, "file.js")];
    mockedGlob.mockResolvedValue(includedFiles as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    // Verify that glob was called with the correct exclude patterns
    expect(mockedGlob).toHaveBeenCalledWith(
      mockConfig.inputs.includes,
      expect.objectContaining({
        ignore: expect.arrayContaining([
          ...(mockConfig.inputs.excludes || []),
          mockConfig.hashFile, // The hash file should be in the exclude patterns
          ".hash-runner.json", // The config file should be in the exclude patterns
        ]),
      }),
    );

    // Verify that the config file was excluded from glob results
    expect(mockedGlob).toHaveBeenCalledWith(
      mockConfig.inputs.includes,
      expect.objectContaining({
        ignore: expect.arrayContaining([".hash-runner.json"]),
      }),
    );
  });

  it("should exclude hash file even when included by wildcard pattern", async () => {
    const mockConfig = getMockConfig({
      inputs: {
        includes: ["*.json"], // This would normally include .hashes.json
        excludes: [],
      },
      hashFile: ".hashes.json",
    });
    setupMocks(mockConfig);

    const fileContent = '{"key": "value"}';
    const currentHashes = {
      "data.json": createHash("sha256").update(fileContent).digest("hex"),
    };

    // Mock that the hash file exists and has the same content as current hashes
    mockedReadFile.mockResolvedValueOnce(JSON.stringify(currentHashes));

    // Mock glob to return only data.json (not .hashes.json)
    const includedFiles = [path.join(mockConfigDir, "data.json")];
    mockedGlob.mockResolvedValue(includedFiles as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    // Verify that glob was called with the correct exclude patterns
    expect(mockedGlob).toHaveBeenCalledWith(
      ["*.json"],
      expect.objectContaining({
        ignore: expect.arrayContaining([
          ...(mockConfig.inputs.excludes || []),
          ".hashes.json", // The hash file should be excluded even with *.json include pattern
        ]),
      }),
    );

    // Verify that .hashes.json was excluded from glob results
    expect(mockedGlob).toHaveBeenCalledWith(
      ["*.json"],
      expect.objectContaining({
        ignore: expect.arrayContaining([".hashes.json"]),
      }),
    );
  });

  it("should exclude config file even when included by wildcard pattern", async () => {
    const mockConfig = getMockConfig({
      inputs: {
        includes: ["*.json"], // This would normally include .hash-runner.json
        excludes: [],
      },
    });
    setupMocks(mockConfig);

    const fileContent = '{"key": "value"}';
    const currentHashes = {
      "data.json": createHash("sha256").update(fileContent).digest("hex"),
    };

    // Mock that the hash file exists and has the same content as current hashes
    mockedReadFile.mockResolvedValueOnce(JSON.stringify(currentHashes));

    // Mock glob to return only data.json (not .hash-runner.json)
    const includedFiles = [path.join(mockConfigDir, "data.json")];
    mockedGlob.mockResolvedValue(includedFiles as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    // Verify that glob was called with the correct exclude patterns
    expect(mockedGlob).toHaveBeenCalledWith(
      ["*.json"],
      expect.objectContaining({
        ignore: expect.arrayContaining([
          ...(mockConfig.inputs.excludes || []),
          mockConfig.hashFile, // The hash file should be excluded
          ".hash-runner.json", // The config file should be excluded even with *.json include pattern
        ]),
      }),
    );

    // Verify that .hash-runner.json was excluded from glob results
    expect(mockedGlob).toHaveBeenCalledWith(
      ["*.json"],
      expect.objectContaining({
        ignore: expect.arrayContaining([".hash-runner.json"]),
      }),
    );
  });

  it("should exclude JavaScript config file even when included by wildcard pattern", async () => {
    const mockConfig = getMockConfig({
      inputs: {
        includes: ["*.js"], // This would normally include hash-runner.config.js
        excludes: [],
      },
    });

    // Mock a different config file path for this test
    const mockConfigPath = path.resolve(__dirname, "..", "hash-runner.config.js");
    const mockConfigDir = path.dirname(mockConfigPath);

    (lilconfig as Mock).mockReturnValue({
      search: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
      load: vi.fn(() => Promise.resolve({ config: mockConfig, filepath: mockConfigPath })),
    });

    const fileContent = "const a = 1;";
    const currentHashes = {
      "app.js": createHash("sha256").update(fileContent).digest("hex"),
    };

    // Mock that the hash file exists and has the same content as current hashes
    mockedReadFile.mockResolvedValueOnce(JSON.stringify(currentHashes));

    // Mock glob to return only app.js (not hash-runner.config.js)
    const includedFiles = [path.join(mockConfigDir, "app.js")];
    mockedGlob.mockResolvedValue(includedFiles as any);
    mockedReadFile.mockResolvedValue(fileContent);

    const runner = createHashRunner();
    await runner.run();

    // Verify that glob was called with the correct exclude patterns
    expect(mockedGlob).toHaveBeenCalledWith(
      ["*.js"],
      expect.objectContaining({
        ignore: expect.arrayContaining([
          ...(mockConfig.inputs.excludes || []),
          mockConfig.hashFile, // The hash file should be excluded
          "hash-runner.config.js", // The config file should be excluded even with *.js include pattern
        ]),
      }),
    );

    // Verify that hash-runner.config.js was excluded from glob results
    expect(mockedGlob).toHaveBeenCalledWith(
      ["*.js"],
      expect.objectContaining({
        ignore: expect.arrayContaining(["hash-runner.config.js"]),
      }),
    );
  });

  it("should alphabetize hash file contents before saving", async () => {
    const mockConfig = getMockConfig();
    setupMocks(mockConfig);

    const fileContent1 = "const a = 1;";
    const fileContent2 = "const b = 2;";
    const fileContent3 = "const c = 3;";

    // Create hashes in non-alphabetical order
    const currentHashes = {
      "zebra.js": createHash("sha256").update(fileContent3).digest("hex"),
      "apple.js": createHash("sha256").update(fileContent1).digest("hex"),
      "banana.js": createHash("sha256").update(fileContent2).digest("hex"),
    };

    // Mock that no previous hash file exists
    mockedReadFile.mockRejectedValueOnce(new Error("File not found"));

    // Mock glob to return the files
    const includedFiles = [
      path.join(mockConfigDir, "apple.js"),
      path.join(mockConfigDir, "banana.js"),
      path.join(mockConfigDir, "zebra.js"),
    ];
    mockedGlob.mockResolvedValue(includedFiles as any);

    // Mock readFile to return different content for each file
    mockedReadFile
      .mockResolvedValueOnce(fileContent1) // apple.js
      .mockResolvedValueOnce(fileContent2) // banana.js
      .mockResolvedValueOnce(fileContent3); // zebra.js

    const runner = createHashRunner();
    await runner.run();

    // Verify that writeFile was called with alphabetized content
    expect(mockedWriteFile).toHaveBeenCalledWith(
      path.join(mockConfigDir, mockConfig.hashFile),
      JSON.stringify(
        {
          hashSchemaVersion: "2",
          inputs: {
            "apple.js": currentHashes["apple.js"],
            "banana.js": currentHashes["banana.js"],
            "zebra.js": currentHashes["zebra.js"],
          },
          outputs: undefined,
        },
        null,
        2,
      ),
    );
  });

  describe("configuration validation", () => {
    it("should throw error for v3 configuration format", async () => {
      const v3Config = {
        include: ["**/*.js"],
        exclude: [],
        execOnChange: 'echo "test"',
        hashFile: ".hashes.json",
      };
      setupMocks(v3Config);

      const runner = createHashRunner();
      await expect(runner.run()).rejects.toThrow(
        "[hash-runner] Detected v3 configuration format. Please see MIGRATING.md for migration instructions.",
      );
    });

    it("should migrate v1 hash file format to v2", async () => {
      const mockConfig = getMockConfig();
      setupMocks(mockConfig);

      const fileContent = "const a = 1;";
      const currentHashes = {
        "file.js": createHash("sha256").update(fileContent).digest("hex"),
      };

      // Simulate old v1 hash file format (just Record<string, string>)
      const v1HashFile = currentHashes;

      mockedReadFile.mockResolvedValueOnce(JSON.stringify(v1HashFile));
      mockedGlob.mockResolvedValue(Object.keys(currentHashes).map((file) => path.join(mockConfigDir, file)) as any);
      mockedReadFile.mockResolvedValue(fileContent);

      const runner = createHashRunner();
      await runner.run();

      expect(spawn).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it("should throw error for invalid v4 configuration", async () => {
      const invalidConfig = {
        execOnChange: 'echo "test"',
        hashFile: ".hashes.json",
        // Missing inputs
      };
      setupMocks(invalidConfig);

      const runner = createHashRunner();
      await expect(runner.run()).rejects.toThrow("[hash-runner] Configuration must have inputs.includes array");
    });
  });

  describe("outputs functionality", () => {
    it("should run command when outputs are missing", async () => {
      const mockConfig = getMockConfig({
        outputs: {
          includes: ["dist/**/*.js"],
        },
      });
      setupMocks(mockConfig);

      const fileContent = "const a = 1;";
      const currentInputHashes = {
        "src/file.js": createHash("sha256").update(fileContent).digest("hex"),
      };
      const hashFile = {
        hashSchemaVersion: "2" as const,
        inputs: currentInputHashes,
        outputs: { "dist/file.js": "somehash" },
      };

      mockedReadFile.mockResolvedValueOnce(JSON.stringify(hashFile));

      // Mock input files glob
      mockedGlob.mockResolvedValueOnce([path.join(mockConfigDir, "src/file.js")] as any);
      // Mock output files glob (returns empty - outputs missing)
      mockedGlob.mockResolvedValueOnce([] as any);

      mockedReadFile.mockResolvedValueOnce(fileContent); // for input file

      // After command runs, mock output files exist
      mockedGlob.mockResolvedValueOnce([path.join(mockConfigDir, "dist/file.js")] as any);
      const outputContent = "console.log('compiled');";
      mockedReadFile.mockResolvedValueOnce(outputContent); // for output file after command

      const runner = createHashRunner();
      await runner.run();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, {
        cwd: mockConfigDir,
        shell: true,
        stdio: "inherit",
      });
    });

    it("should run command when outputs have changed", async () => {
      const mockConfig = getMockConfig({
        outputs: {
          includes: ["dist/**/*.js"],
        },
      });
      setupMocks(mockConfig);

      const fileContent = "const a = 1;";
      const currentInputHashes = {
        "src/file.js": createHash("sha256").update(fileContent).digest("hex"),
      };

      const oldOutputContent = "console.log('old');";
      const newOutputContent = "console.log('new');";

      const hashFile = {
        hashSchemaVersion: "2" as const,
        inputs: currentInputHashes,
        outputs: { "dist/file.js": createHash("sha256").update(oldOutputContent).digest("hex") },
      };

      mockedReadFile.mockResolvedValueOnce(JSON.stringify(hashFile));

      // Mock input files glob
      mockedGlob.mockResolvedValueOnce([path.join(mockConfigDir, "src/file.js")] as any);
      // Mock output files glob
      mockedGlob.mockResolvedValueOnce([path.join(mockConfigDir, "dist/file.js")] as any);

      mockedReadFile.mockResolvedValueOnce(fileContent); // for input file
      mockedReadFile.mockResolvedValueOnce(newOutputContent); // for output file (changed)

      // After command runs, mock output files exist
      mockedGlob.mockResolvedValueOnce([path.join(mockConfigDir, "dist/file.js")] as any);
      mockedReadFile.mockResolvedValueOnce(newOutputContent); // for output file after command

      const runner = createHashRunner();
      await runner.run();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(mockConfig.execOnChange, {
        cwd: mockConfigDir,
        shell: true,
        stdio: "inherit",
      });
    });

    it("should not run command when inputs and outputs are unchanged", async () => {
      const mockConfig = getMockConfig({
        outputs: {
          includes: ["dist/**/*.js"],
        },
      });
      setupMocks(mockConfig);

      const inputContent = "const a = 1;";
      const outputContent = "console.log('compiled');";

      const currentInputHashes = {
        "src/file.js": createHash("sha256").update(inputContent).digest("hex"),
      };
      const currentOutputHashes = {
        "dist/file.js": createHash("sha256").update(outputContent).digest("hex"),
      };

      const hashFile = {
        hashSchemaVersion: "2" as const,
        inputs: currentInputHashes,
        outputs: currentOutputHashes,
      };

      mockedReadFile.mockResolvedValueOnce(JSON.stringify(hashFile));

      // Mock input files glob
      mockedGlob.mockResolvedValueOnce([path.join(mockConfigDir, "src/file.js")] as any);
      // Mock output files glob
      mockedGlob.mockResolvedValueOnce([path.join(mockConfigDir, "dist/file.js")] as any);

      mockedReadFile.mockResolvedValueOnce(inputContent); // for input file
      mockedReadFile.mockResolvedValueOnce(outputContent); // for output file

      const runner = createHashRunner();
      await runner.run();

      expect(spawn).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });
});
