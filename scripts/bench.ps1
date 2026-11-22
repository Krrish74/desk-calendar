# bench.ps1: run the assistant cost benchmark (scripts/bench-assistant.js) with a key you paste.
#
#   .\scripts\bench.ps1
#
# Asks for your Claude API key (typing is hidden), keeps it only in this window's memory for
# the run, then clears it. Spends a few cents on Claude Haiku 5.5 (it stops at $0.25).
$secure = Read-Host -AsSecureString 'Paste your Claude API key (it stays on this PC)'
$env:ANTHROPIC_API_KEY = [System.Net.NetworkCredential]::new('', $secure).Password
try {
  npm run bench
} finally {
  Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
}
