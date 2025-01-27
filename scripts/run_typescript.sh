#!/bin/bash

cd "$(dirname "$0")/../typescriptRaydium"

if [ "$1" == "fetch-pools" ]; then
  npm run fetch-pools
elif [ "$1" == "get-quote" ]; then
  npm run get-quote -- "${@:2}"
elif [ "$1" == "swap" ]; then
  npm run swap -- "${@:2}"
else
  echo "Invalid command. Usage: ./run_typescript.sh [fetch-pools|get-quote|swap] [args]"
  exit 1
fi
