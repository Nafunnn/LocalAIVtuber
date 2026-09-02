# LocalAIVtuber Environment Setup Script
# Run: powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$VenvPython = Join-Path $Backend "venv\Scripts\python.exe"
$VenvPip = Join-Path $Backend "venv\Scripts\pip.exe"

Write-Host "=== LocalAIVtuber Setup ===" -ForegroundColor Cyan

# 1. Python venv
if (-not (Test-Path $VenvPython)) {
    Write-Host "[1/5] Creating Python venv..." -ForegroundColor Yellow
    Set-Location $Backend
    python -m venv venv
    & $VenvPip install --upgrade pip
} else {
    Write-Host "[1/5] Python venv already exists" -ForegroundColor Green
}

# 2. Backend dependencies
Write-Host "[2/5] Installing backend dependencies (this may take a while)..." -ForegroundColor Yellow
Set-Location $Backend

& $VenvPip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
& $VenvPip install fastapi "uvicorn[standard]" websockets wsproto "qdrant-client[fastembed]==1.12.1" pyautogui sounddevice silero-vad easyocr==1.7.2 mss numpy==1.23.4 pytchat soxr ollama httpx aiofiles aiohttp jinja2
& $VenvPip install "setuptools<81" librosa==0.9.2 numba==0.56.4 soundfile ffmpeg-python "transformers==4.43.4" peft sentencepiece modelscope==1.10.0 faster-whisper cn2an pypinyin g2p_en jieba split-lang fast_langdetect rotary_embedding_torch x_transformers torchmetrics pydub pytorch-lightning funasr gradio onnxruntime-gpu

# NLTK data for TTS text processing
& $VenvPython -c "import nltk; nltk.download('cmudict', quiet=True); nltk.download('averaged_perceptron_tagger_eng', quiet=True)"

# Optional: local GGUF models (skip if using Ollama Cloud only)
$installLlama = Read-Host "Install llama-cpp-python for local GGUF models? (y/N)"
if ($installLlama -eq "y" -or $installLlama -eq "Y") {
    & $VenvPip install llama-cpp-python==0.2.90 --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124
}

# 3. FFmpeg
Write-Host "[3/5] Checking ffmpeg..." -ForegroundColor Yellow
$ffmpegBackend = Join-Path $Backend "ffmpeg.exe"
if (-not (Test-Path $ffmpegBackend)) {
    $ffmpegPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($ffmpegPath) {
        Copy-Item $ffmpegPath.Source $ffmpegBackend -Force
        $ffprobe = Join-Path (Split-Path $ffmpegPath.Source) "ffprobe.exe"
        if (Test-Path $ffprobe) { Copy-Item $ffprobe (Join-Path $Backend "ffprobe.exe") -Force }
        Write-Host "  ffmpeg copied to backend/" -ForegroundColor Green
    } else {
        Write-Host "  ffmpeg not found. Install with: winget install Gyan.FFmpeg" -ForegroundColor Red
    }
} else {
    Write-Host "  ffmpeg already in backend/" -ForegroundColor Green
}

# 4. TTS pretrained models
Write-Host "[4/5] Downloading TTS pretrained models..." -ForegroundColor Yellow
Set-Location $Root
& $VenvPython (Join-Path $Root "scripts\download_tts_assets.py")

# 5. Frontend build
Write-Host "[5/5] Building frontend..." -ForegroundColor Yellow
Set-Location $Frontend
if (-not (Test-Path "node_modules")) { npm install }
node ".\node_modules\typescript\bin\tsc" -b
node ".\node_modules\vite\bin\vite.js" build

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Set OLLAMA_API_KEY (for Ollama Cloud):"
Write-Host "       set OLLAMA_API_KEY=your_key_here"
Write-Host "  2. Copy voice reference.wav files to:"
Write-Host "       backend\services\TTS\GPTsovits\models\{leaf,nene,miyabi}\"
Write-Host "     (from release package if TTS voices are missing)"
Write-Host "  3. Run: start.bat"
Write-Host "  4. Open: http://localhost:8000"
Write-Host "  5. Settings -> LLM Provider -> Ollama Cloud"
