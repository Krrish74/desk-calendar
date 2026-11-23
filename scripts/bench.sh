#!/usr/bin/env bash
# bench.sh: run the assistant cost benchmark (scripts/bench-assistant.js) with a key you paste.
# The macOS / Linux twin of bench.ps1.
#
#   ./scripts/bench.sh        (or: bash scripts/bench.sh)
#
# Asks for your Claude API key (typing is hidden), keeps it only in this terminal's memory for
# the run, then clears it. Spends a few cents on Claude Haiku 5.5 (it stops at $0.25).
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -s -p 'Paste your Claude API key (it stays on this computer): ' ANTHROPIC_API_KEY
echo
export ANTHROPIC_API_KEY
trap 'unset ANTHROPIC_API_KEY' EXIT
npm run bench
