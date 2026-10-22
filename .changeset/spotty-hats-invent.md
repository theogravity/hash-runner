---
"hash-runner": major
---

Update all dependencies to their latest majors (commander 15, glob 13, debug 4.4.3, lilconfig 3.1.4) and modernize the toolchain (TypeScript 7, vitest 5, biome 2.5, pnpm 12).

**Breaking:** Node.js >= 22.12.0 is now required (the floor commander 15 sets).

Also fixes the CLI so `--help` lists all options (the option flags were each registered after a separate parse, so `-f/--force` and `-s/--silent` were invisible to help and parsed late), and releases now publish to npm through OIDC trusted publishing from GitHub Actions instead of an `NPM_TOKEN`.
