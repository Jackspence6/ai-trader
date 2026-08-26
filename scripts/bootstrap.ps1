# From a fresh clone to a running console, on Windows.
#
# The bash version (bootstrap.sh) is the reference; this is the same sequence
# for a machine that has no bash. It deliberately does less: it does not touch
# Docker. Docker Desktop on Windows needs WSL2 and about 2GB of its own, which
# on the kind of machine this script exists for is the difference between a
# console that runs and one that swaps itself to a standstill. The database and
# the events engine are a second, optional step — see docs/deploy-old-machine.md.
#
# Run it from a PowerShell window opened in the repository folder:
#
#     powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
#
# Safe to re-run. It never overwrites .env.local.

$ErrorActionPreference = "Stop"

function Say($m)  { Write-Host ""; Write-Host $m -ForegroundColor White }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function No($m)   { Write-Host "  [--] $m" -ForegroundColor Red }

Set-Location (Join-Path $PSScriptRoot "..")

Say "Toolchain"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  No "Node is not installed."
  Write-Host "     Download the LTS installer from https://nodejs.org and run it," -ForegroundColor Gray
  Write-Host "     then close this window, open a new one, and run this script again." -ForegroundColor Gray
  exit 1
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
  No "Node $(node --version) is too old — this needs 22 or newer."
  Write-Host "     https://nodejs.org, take the LTS download." -ForegroundColor Gray
  exit 1
}
Ok "node $(node --version)"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Say "Installing pnpm"
  corepack enable
  corepack prepare pnpm@10.33.0 --activate
}
Ok "pnpm $(pnpm --version)"

Say "Dependencies"
# --frozen-lockfile first: it installs exactly the tested tree and fails loudly
# if the lockfile and package.json disagree, which is worth knowing about.
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  No "frozen install failed — falling back to a normal install"
  pnpm install
  if ($LASTEXITCODE -ne 0) { No "install failed — see above"; exit 1 }
}
Ok "packages installed"

Say "Build"
# Peak build memory is about 1.5GB. On a machine with 4GB that is fine; below
# that, Windows will page and it will be slow rather than fatal. The cap keeps
# Node from growing into swap and thrashing.
$env:NODE_OPTIONS = "--max-old-space-size=2048"
pnpm build
if ($LASTEXITCODE -ne 0) {
  No "build failed — see above"
  Write-Host "     If it ran out of memory, use the prebuilt bundle instead:" -ForegroundColor Gray
  Write-Host "     docs\deploy-old-machine.md, section 'If the build will not finish'." -ForegroundColor Gray
  exit 1
}
Remove-Item Env:\NODE_OPTIONS
Ok "console built"

Say "Configuration"
if (-not (Test-Path ".env.local")) {
  Copy-Item ".env.example" ".env.local"
  Ok "created .env.local from .env.example"
  Write-Host "     Open it and set SITE_PASSWORD before starting." -ForegroundColor Gray
} else {
  Ok ".env.local exists (left alone)"
}

Say "Preflight"
pnpm preflight
if ($LASTEXITCODE -eq 0) { Ok "preflight clean" } else { No "preflight found problems — read them above" }

Say "Next"
Write-Host @"
  pnpm start                     the console on :3000
  pnpm trade -- --interval 300   the Asset Markets loop — exactly one instance
  pnpm record                    the market-data recorder

  The database and the events engine need Docker and are a separate step.
  docs\deploy-old-machine.md has both, and what you lose by skipping them.
"@
