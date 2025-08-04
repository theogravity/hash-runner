[![NPM version](https://img.shields.io/npm/v/hash-runner.svg?style=flat-square)](https://www.npmjs.com/package/hash-runner)
![NPM Downloads](https://img.shields.io/npm/dm/hash-runner)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)

`hash-runner` executes a command when a change is detected in specified files.
It calculates the SHA256 hash of the files and compares them to the previous hash values stored in a file.
If the hashes differ, the specified command is executed.

*This tool is not an active file watcher that constantly checks for changes.*

## Use-case

It is designed to be used in conjunction with tools like [`turbo`](https://turbo.build/),
where the watch mode may trigger unnecessary builds even when caching is used.

For example, consider the following `turbo` configuration:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "dev": {
      "dependsOn": ["@internal/some-package#build"],
      "cache": false,
      "persistent": true
    }
  }
}
```

When running `turbo [watch] dev`, it will trigger a build even when no changes are detected in `@internal/some-package`.

By using `hash-runner`, the `build` command will still run on `@internal/some-package`, but it won't actually
execute the underlying build command unless changes are detected.

## Installation

Node.js 20 or higher is required.

To install `hash-runner`, use npm:

```sh
npm install hash-runner --save-dev
```

## Usage

`hash-runner [--config <config-file>] [--force] [--silent]`

CLI options:

* `-c / --config <config-file>`: Specify a custom configuration file.
* `-f / --force`: Force the creation of a new hash file and execute.
* `-s / --silent`: Suppress log output.

### Configuration

`hash-runner` uses [`lilconfig`](https://github.com/antonk52/lilconfig) to read configuration.

`lilconfig` will check the current directory for the following:

- a `hash-runner` property in `package.json`
- a `.hash-runnerrc` file in JSON or YAML format
- a `.hash-runnerrc.json`, `.hash-runnerrc.js`, `.hash-runnerrc.ts`, `.hash-runnerrc.mjs`, or `.hash-runnerrc.cjs` file
- a `hash-runnerrc`, `hash-runnerrc.json`, `hash-runnerrc.js`, `hash-runnerrc.ts`, `hash-runnerrc.mjs`, or `hash-runnerrc.cjs` file inside a `.config` subdirectory
- a `hash-runner.config.js`, `hash-runner.config.ts`, `hash-runner.config.mjs`, or `hash-runner.config.cjs` file

#### Configuration options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `inputs` | object | Yes | Contains input file configuration |
| `inputs.includes` | string[] | Yes | Array of glob patterns specifying files to include in hash calculation |
| `inputs.excludes` | string[] | No | Array of glob patterns specifying files to exclude from hash calculation |
| `outputs` | object | No | Contains output file configuration for tracking build artifacts |
| `outputs.includes` | string[] | Yes* | Array of glob patterns specifying output files to track (*required if `outputs` is defined) |
| `outputs.excludes` | string[] | No | Array of glob patterns specifying output files to exclude from tracking |
| `execOnChange` | string | Yes | Command to execute when changes are detected |
| `hashFile` | string | Yes | Path to file where hashes are stored (recommend adding to `.gitignore`) |
| `parallelizeComparisonsChunkSize` | number | No | Number of files per chunk for parallelizing hash comparison (default: 100) |

**Notes:**
- The hash file and configuration file are automatically excluded from hash calculations
- If outputs are configured but missing or changed, the cache is considered stale and the command executes
- `hash-runner` exits with the status code of the executed command

#### Examples

Run `tsc` when changes are detected in files in the `src` directory:

`package.json`:

```json
{
  "scripts": {
    "build": "hash-runner",
    "build:files": "tsc"
  }
}
```

Example configuration file (`.hash-runnerrc.json`):

```json
{
  "inputs": {
    "includes": ["src/**/*.ts"],
    "excludes": ["dist/**"]
  },
  "outputs": {
    "includes": ["dist/**/*.js"],
    "excludes": ["dist/**/*.map"]
  },
  "execOnChange": "npm run build:files",
  "hashFile": ".hashes.json"
}
```

`hash-runner.config.js`:

```js
module.exports = {
  inputs: {
    includes: ['src/**/*.ts'],
    excludes: ['dist/**']
  },
  outputs: {
    includes: ['dist/**/*.js'],
    excludes: ['dist/**/*.map']
  },
  execOnChange: 'npm run build:files',
  hashFile: '.hashes.json'
};
```

### Basic Configuration (Inputs Only)

If you only need to track input files (similar to v3 behavior):

```json
{
  "inputs": {
    "includes": ["src/**/*.ts"]
  },
  "execOnChange": "npm run build:files",
  "hashFile": ".hashes.json"
}
```

`npm run build` will only run `tsc` when changes are detected in files in the `src` directory.

## Migration from v3 to v4

If you're upgrading from hash-runner v3, you'll need to manually update your configuration to the v4 format. For detailed migration instructions, see [MIGRATING.md](./MIGRATING.md).

### CI Mode

When running in a Continuous Integration (CI) environment, `hash-runner` will bypass hash checks and execute the specified command directly. This is controlled by the `CI` environment variable.
To enable CI mode, set the `CI` environment variable to `true`:

```json
{
  "scripts": {
    "build": "hash-runner",
    "build:ci": "CI=true hash-runner",
    "build:files": "tsc"
  }
}
```

This will bypass hash checks and execute the specified command directly.

## API

In addition to the CLI, `hash-runner` can also be used programmatically:

```typescript
import { HashRunner } from 'hash-runner';

const runner = new HashRunner('/path/to/config.json', { force: true });
await runner.run();
```

### Constructor and Parameters

#### `HashRunner(configPath?: string, options: HashRunnerOptions = {})`

**Parameters:**

- `configPath` (optional): A string representing the path to the configuration file. If not specified, `hash-runner` 
will attempt to load the configuration from the current directory.
- `options` (optional): An object containing options to configure the behavior of `hash-runner`.

#### `HashRunnerOptions`

- `force?` (boolean): Force the creation of a new hash file and execute the command regardless of detected changes.
- `silent?` (boolean): Suppress log output when set to `true`.

## Troubleshooting

This library uses `debug` to log messages. To enable debug messages, set the `DEBUG` environment variable to `hash-runner`.

```sh
DEBUG=hash-runner hash-runner
```
