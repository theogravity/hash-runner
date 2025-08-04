# Migrating from hash-runner v3 to v4

v4 has a new configuration format and adds an `outputs` object to track output files.

v3 or older configuration:

```json
{
    "include": ["src/**"],
    "exclude": ["src/generated/**"],
    "execOnChange": "npm run build",
    "hashFile": ".hashes.json"
}
```

v4 configuration:

```json
{
    "inputs": {
        "includes": ["src/**"],
        "excludes": ["src/generated/**"]
    },
    "execOnChange": "npm run build",
    "hashFile": ".hashes.json"
}
```

To add support for outputs, you can modify the configuration like this:

```json
{
    "inputs": {
        "includes": ["src/**"],
        "excludes": ["src/generated/**"]
    },
    "outputs": {
        "includes": ["dist/**"]
    },
    "execOnChange": "npm run build",
    "hashFile": ".hashes.json"
}
```
