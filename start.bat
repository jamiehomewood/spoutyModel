@echo off
cd /d "%~dp0"
title spoutyModel
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8010/"
where py >nul 2>&1 && (py -3 serve.py) || (python serve.py)
pause
