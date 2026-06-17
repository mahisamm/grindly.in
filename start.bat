@echo off
REM InternPilot one-command start (Windows). Double-click or run from cmd.
REM Starts: Ollama (if down) -> agent daily scheduler -> Next web app.

cd /d "%~dp0"

echo [InternPilot] ensuring Ollama is running...
tasklist /FI "IMAGENAME eq ollama.exe" | find /I "ollama.exe" >nul
if errorlevel 1 (
  start "" /B ollama serve
  timeout /t 3 >nul
)

echo [InternPilot] starting agent daily scheduler (mock mode) in a new window...
start "InternPilot Agent" cmd /k "python agent\worker.py --loop --mode mock"

echo [InternPilot] starting web app on http://localhost:3000 ...
call npm run dev
