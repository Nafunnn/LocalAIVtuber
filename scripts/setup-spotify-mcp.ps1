# Setup Spotify MCP server for LocalAIVtuber
# Requires: Node.js 16+, git, npm

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $RepoRoot "third_party\spotify-mcp-server"
$RepoUrl = "https://github.com/marcelmarais/spotify-mcp-server.git"

Write-Host "=== Spotify MCP Setup ===" -ForegroundColor Cyan
Write-Host "Target: $TargetDir"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required (v16+). Install from https://nodejs.org/"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is required. Install Node.js which includes npm."
}

$ThirdParty = Join-Path $RepoRoot "third_party"
if (-not (Test-Path $ThirdParty)) {
    New-Item -ItemType Directory -Path $ThirdParty | Out-Null
}

if (-not (Test-Path (Join-Path $TargetDir "package.json"))) {
    Write-Host "Cloning spotify-mcp-server..."
    if (Test-Path $TargetDir) {
        Remove-Item -Recurse -Force $TargetDir
    }
    git clone --depth 1 $RepoUrl $TargetDir
} else {
    Write-Host "Repository already present; skipping clone."
}

Push-Location $TargetDir
try {
    Write-Host "Installing npm dependencies..."
    npm install

    Write-Host "Building TypeScript..."
    # Avoid npm script path issues when the repo path contains '&'
    $tsc = Join-Path $TargetDir "node_modules\typescript\bin\tsc"
    if (-not (Test-Path $tsc)) {
        Write-Error "TypeScript not found at $tsc after npm install."
    }
    node $tsc
    if ($LASTEXITCODE -ne 0) {
        Write-Error "TypeScript build failed."
    }

    $indexJs = Join-Path $TargetDir "build\index.js"
    if (-not (Test-Path $indexJs)) {
        Write-Error "Build succeeded but $indexJs is missing."
    }
    Write-Host "Built: $indexJs" -ForegroundColor Green

    $configPath = Join-Path $TargetDir "spotify-config.json"
    $examplePath = Join-Path $TargetDir "spotify-config.example.json"
    if (-not (Test-Path $configPath)) {
        Copy-Item $examplePath $configPath
        Write-Host "Created spotify-config.json from example." -ForegroundColor Yellow
        Write-Host "Edit it with your Spotify Client ID and Secret, then run:" -ForegroundColor Yellow
        Write-Host "  cd `"$TargetDir`""
        Write-Host "  npm run auth"
        Write-Host "If npm run auth fails due to '&' in the path, use:"
        Write-Host "  node .\node_modules\typescript\bin\tsc"
        Write-Host "  node .\build\auth.js"
    } else {
        Write-Host "spotify-config.json already exists; leaving it unchanged."
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Create a Spotify Developer app: https://developer.spotify.com/dashboard"
Write-Host "2. Add Redirect URI: http://127.0.0.1:8888/callback"
Write-Host "3. Fill clientId / clientSecret in: $TargetDir\spotify-config.json"
Write-Host "4. Run auth: cd `"$TargetDir`"; npm run auth"
Write-Host "5. Enable Spotify MCP in LocalAIVtuber Settings"
Write-Host "See docs/SPOTIFY_MCP.md for full guide."
Write-Host "=== Done ===" -ForegroundColor Green
