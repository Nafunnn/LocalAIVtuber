# Setup Better Browser MCP for LocalAIVtuber

# Requires: Node.js 16+, git, npm, Google Chrome



$ErrorActionPreference = "Stop"



$RepoRoot = Split-Path -Parent $PSScriptRoot

$ServerDir = Join-Path $RepoRoot "third_party\betterbrowsermcp"

$ExtensionDir = Join-Path $RepoRoot "third_party\betterbrowsermcp-extension"

$ServerRepo = "https://github.com/nbiish/betterbrowsermcp.git"

$ExtensionRepo = "https://github.com/nbiish/betterbrowsermcp-extension.git"

$DefaultPort = 9010

$DefaultAgentId = "localaivtuber"



Write-Host "=== Better Browser MCP Setup ===" -ForegroundColor Cyan



if (-not (Get-Command node -ErrorAction SilentlyContinue)) {

    Write-Error "Node.js is required (v16+). Install from https://nodejs.org/"

}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {

    Write-Error "npm is required. Install Node.js which includes npm."

}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {

    Write-Error "git is required to clone betterbrowsermcp."

}



Write-Host "Node.js: $(node -v)" -ForegroundColor Green



$ThirdParty = Join-Path $RepoRoot "third_party"

if (-not (Test-Path $ThirdParty)) {

    New-Item -ItemType Directory -Path $ThirdParty | Out-Null

}



function Clone-IfMissing {

    param(

        [string]$TargetDir,

        [string]$RepoUrl,

        [string]$Label

    )

    if (-not (Test-Path (Join-Path $TargetDir ".git"))) {

        Write-Host "Cloning $Label..."

        if (Test-Path $TargetDir) {

            Remove-Item -Recurse -Force $TargetDir

        }

        git clone --depth 1 $RepoUrl $TargetDir

    } else {

        Write-Host "$Label already present; skipping clone."

    }

}



Clone-IfMissing -TargetDir $ServerDir -RepoUrl $ServerRepo -Label "betterbrowsermcp server"

Clone-IfMissing -TargetDir $ExtensionDir -RepoUrl $ExtensionRepo -Label "betterbrowsermcp extension"



Push-Location $ServerDir

try {

    Write-Host "Installing server dependencies..."
    npm install --ignore-scripts

    Write-Host "Building Better Browser MCP server..."
    # Avoid npm script path issues when the repo path contains '&'
    $tsup = Join-Path $ServerDir "node_modules\tsup\dist\cli-default.js"
    if (-not (Test-Path $tsup)) {
        Write-Error "tsup not found at $tsup after npm install."
    }
    node $tsup src/index.ts --format esm
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Server build failed."
    }



    $indexJs = Join-Path $ServerDir "dist\index.js"

    if (-not (Test-Path $indexJs)) {

        Write-Error "Build succeeded but $indexJs is missing."

    }

    Write-Host "Built: $indexJs" -ForegroundColor Green

}

finally {

    Pop-Location

}



Write-Host ""

Write-Host "=== Chrome Extension (required) ===" -ForegroundColor Cyan

Write-Host "1. Open chrome://extensions"

Write-Host "2. Enable Developer mode"

Write-Host "3. Load unpacked -> select:"

Write-Host "   $ExtensionDir"

Write-Host "4. In the extension popup, add an agent:"

Write-Host "   Agent ID: $DefaultAgentId"

Write-Host "   Port:     $DefaultPort"

Write-Host "   (URL: ws://127.0.0.1:$DefaultPort/ws/$DefaultAgentId)"

Write-Host "5. Open a tab and bind it to agent '$DefaultAgentId'"

Write-Host ""

Write-Host "=== Coexist with Cursor ===" -ForegroundColor Cyan

Write-Host "- Cursor can keep @browsermcp/mcp on port 9009"

Write-Host "- LocalAIVtuber uses Better Browser MCP on port $DefaultPort (no port fighting)"

Write-Host ""

Write-Host "=== LocalAIVtuber ===" -ForegroundColor Cyan

Write-Host "1. Start backend + frontend"

Write-Host "2. Settings -> Ollama Cloud -> enable Browser MCP"

Write-Host "3. Status should show ready when the extension is bound to the tab"

Write-Host ""

Write-Host "See docs/BROWSER_MCP.md for troubleshooting."

Write-Host "=== Done ===" -ForegroundColor Green

