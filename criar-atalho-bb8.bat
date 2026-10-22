@echo off
rem Cria na Area de Trabalho um atalho "BB-8" que liga a ponte e abre a pagina.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$desk = [Environment]::GetFolderPath('Desktop');" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk 'BB-8.lnk'));" ^
  "$s.TargetPath = (Join-Path (Get-Location) 'iniciar-bb8.bat');" ^
  "$s.WorkingDirectory = (Get-Location).Path;" ^
  "$s.Description = 'Liga a ponte do BB-8 e abre o controle no navegador';" ^
  "$s.Save()"
echo Atalho "BB-8" criado na Area de Trabalho.
pause
