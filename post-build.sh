#!/bin/bash

# Define the base directory
directory="dist/esm"

# Find all .js files and rename them to .mjs
find "$directory" -type f -name "*.js" | while read file; do
  mv "$file" "${file%.js}.mjs"
  echo "Renamed $file to ${file%.js}.mjs"
done

# Rename .js.map files to .mjs.map
find "$directory" -type f -name "*.js.map" | while read file; do
  mv "$file" "${file%.js.map}.mjs.map"
  echo "Renamed $file to ${file%.js.map}.mjs.map"
done
