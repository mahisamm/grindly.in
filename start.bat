@echo off
REM Grindly one-command start (Windows). Double-click or run from cmd.
REM Starts: Ollama (if down) -> queue worker -> daily scheduler -> Next web app.

cd /d "%~dp0"

REM Prefer the project virtual environment so the worker always has its pinned
REM Python dependencies. Fall back to PATH only when the environment has not
REM been created yet.
if exist ".venv\Scripts\python.exe" (
  set "GRINDLY_PYTHON=.venv\Scripts\python.exe"
) else (
  set "GRINDLY_PYTHON=python"
)

echo [Grindly] ensuring Ollama is running...
tasklist /FI "IMAGENAME eq ollama.exe" | find /I "ollama.exe" >nul
if errorlevel 1 (
  start "" /B ollama serve
  timeout /t 3 >nul
)

echo [Grindly] starting the queue worker in a new window...
REM The worker drains submitted work. It must stay alive so dashboard actions
REM and the daily scheduler are processed without a user keeping this terminal open.
start "Grindly Worker" cmd /k ""%GRINDLY_PYTHON%" agent\worker.py --serve"

echo [Grindly] starting the daily internship scheduler in a new window...
REM The scheduler enqueues one live run per active user per day. `mock` was a
REM retired mode and made the old launcher exit before any agent work began.
start "Grindly Scheduler" cmd /k ""%GRINDLY_PYTHON%" agent\sweep.py --serve"

echo [Grindly] starting web app on http://localhost:3000 ...
call npm run dev
