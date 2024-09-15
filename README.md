# hash-runner

[![NPM version](https://img.shields.io/npm/v/loglayer.svg?style=flat-square)](https://www.npmjs.com/package/hash-runner)
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

`hash-runner [--config <config-file>]`

### Configuration

`hash-runner` uses [`lilconfig`](https://github.com/antonk52/lilconfig) to read configuration.

`lilconfig` will check the current directory for the following:

- a `hash-runner` property in `package.json`
- a `.hash-runnerrc` file in JSON or YAML format
- a `.hash-runnerrc.json`, `.hash-runnerrc.js`, `.hash-runnerrc.ts`, `.hash-runnerrc.mjs`, or `.hash-runnerrc.cjs` file
- a `hash-runnerrc`, `hash-runnerrc.json`, `hash-runnerrc.js`, `hash-runnerrc.ts`, `hash-runnerrc.mjs`, or `hash-runnerrc.cjs` file inside a `.config` subdirectory
- a `hash-runner.config.js`, `hash-runner.config.ts`, `hash-runner.config.mjs`, or `hash-runner.config.cjs` file

#### Configuration options

- `include`: An array of glob patterns specifying the files to include in the hash calculation.
- `exclude`: An array of glob patterns specifying the files to exclude from the hash calculation.
  * `node_modules` is always excluded and does not need to be specified.
- `execOnChange`: The command to execute when changes are detected.
  * `hash-runner` will exit with the status code of the executed command after completion.
- `hashFile`: The path to the file where hashes are stored.
  * It is recommended you add the `hashFile` to your `.gitignore` file.

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
  "include": ["src/**/*.ts"],
  "exclude": ["dist/**"],
  "execOnChange": "npm run build:files",
  "hashFile": ".hashes.json"
}
```

`hash-runner.config.js`:

```js
module.exports = {
  include: ['src/**/*.ts'],
  exclude: ['dist/**'],
  execOnChange: 'npm run build:files',
  hashFile: '.hashes.json'
};
```

`npm run build` will only run `tsc` when changes are detected in files in the `src` directory.

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
import { hashRunner } from 'hash-runner';

// Run hash runner with a custom configuration file
await hashRunner('/path/to/config.yaml')
```
