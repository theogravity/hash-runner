# hash-runner

[![NPM version](https://img.shields.io/npm/v/loglayer.svg?style=flat-square)](https://www.npmjs.com/package/hash-runner)
![NPM Downloads](https://img.shields.io/npm/dm/hash-runner)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)

`hash-runner` executes a command when a change is detected in specified files. 
It calculates the SHA256 hash of the files and compares them to the previous hash values stored in a file. 
If the hashes differ, the specified command is executed.

## Features

- Detects changes in specified files using SHA256 hashing.
- Executes a specified command when file changes are detected.
- Supports custom configurations using a configuration file.
- Can be easily integrated into CI environments.

## Installation

To install `hash-runner`, use npm:

```sh
npm install hash-runner
```

## Usage

`hash-runner [--config <config-file>]`

### Configuration

The configuration file should be in JSON or YAML format and can include the following properties:

- `include`: An array of glob patterns specifying the files to include in the hash calculation.
- `exclude`: An array of glob patterns specifying the files to exclude from the hash calculation.
  * `node_modules` is always excluded and does not need to be specified.
- `execOnChange`: The command to execute when changes are detected.
- `hashFile`: The path to the file where hashes are stored.

Example configuration file (`.hash-runner.json`):

```json
{
  "include": ["src/**/*.ts"],
  "exclude": ["dist/**"],
  "execOnChange": "npm run build",
  "hashFile": ".hashes.json"
}
```

```js
export default {
  include: ['src/**/*.ts'],
  exclude: ['dist/**'],
  execOnChange: 'npm run build',
  hashFile: '.hashes.json'
};
```

By default, looks for a configuration file named:

- `.hash-runner.json`
- `.hash-runner.yaml`
- `.hash-runner.js`

#### Example

Do not run `tsc` if the files in the `src` directory have not changed:

`.hash-runner.json`:

```json
{
  "include": ["src/**/*.ts"],
  "exclude": ["dist/**"],
  "execOnChange": "npm run build:files",
  "hashFile": ".hashes.json"
}
```

`package.json`:

```json
{
  "scripts": {
    "build": "hash-runner",
    "build:files": "tsc"
  }
}
```

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
