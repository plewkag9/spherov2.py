@echo off
rem Duplo clique para ligar a ponte do BB-8 no Windows.
cd /d "%~dp0"
python -m bb8_app %*
echo.
pause
