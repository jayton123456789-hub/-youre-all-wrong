@echo off
setlocal
cd /d "%~dp0"

set "YAW_VOICE_ENGINE=qwen3-tts"
set "YAW_QWEN_PROFILE_PATH=%~dp0assets\voice\original-host-v1\profile.json"
set "YAW_QWEN_PYTHON_PATH=%~dp0.yallwrong\qwen-tts-venv\Scripts\python.exe"
set "YAW_QWEN_BASE_MODEL_PATH=%~dp0.yallwrong\qwen-models\base-0.6b"
set "YAW_QWEN_ASR_MODEL_PATH=%~dp0.yallwrong\qwen-models\asr-small-en"
set "YAW_QWEN_MODEL_CACHE_PATH=%~dp0.yallwrong\qwen-models"

call npm.cmd run build
if errorlevel 1 (
  echo.
  echo The playtest build failed. Leave this window open and send its error to Codex.
  pause
  exit /b 1
)

start "YOU'RE ALL WRONG! - Voice 2 Playtest" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0dist\desktop\main.cjs"
endlocal
