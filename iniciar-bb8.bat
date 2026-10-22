@echo off
rem Duplo clique para ligar a ponte do BB-8 no Windows e abrir a pagina no navegador.
cd /d "%~dp0"
python -m bb8_app --open %*
echo.
pause
