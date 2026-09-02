@echo off
setlocal

REM ============================================================
REM LocalAIVtuber - Start Server
REM ============================================================

REM Fix Unicode console output on Windows (EasyOCR progress bars, etc.)
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

REM Ollama Cloud API key (required when using Ollama Cloud provider)
REM Get your key at: https://ollama.com/settings/keys
REM set OLLAMA_API_KEY=your_api_key_here

cd /d "%~dp0backend"

REM Stop previous server instance if port 8000 is still in use
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    echo Stopping existing server on port 8000 ^(PID %%a^)...
    taskkill /F /PID %%a >nul 2>&1
)

if exist "runtime\python.exe" (
    set PYTHON=runtime\python.exe
) else if exist "venv\Scripts\python.exe" (
    set PYTHON=venv\Scripts\python.exe
) else (
    echo ERROR: Python not found. Run setup.ps1 first.
    pause
    exit /b 1
)

echo Starting LocalAIVtuber server...
echo Web UI: http://localhost:8000
echo.

"%PYTHON%" server.py
pause
