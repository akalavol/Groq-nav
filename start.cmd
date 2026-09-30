@echo off
rem Demarre Groq Nav et ouvre le navigateur. Lance install.cmd d'abord
rem si les dependances ne sont pas encore installees.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto need_install
if not exist node_modules goto need_install
goto run

:need_install
echo Dependances manquantes, lancement de install.cmd...
call "%~dp0install.cmd"
if errorlevel 1 exit /b 1
where node >nul 2>nul
if errorlevel 1 set "PATH=%ProgramFiles%\nodejs;%PATH%"

:run
set "GN_PORT=3000"
for /f "tokens=2 delims==" %%p in ('findstr /b /c:"PORT=" .env 2^>nul') do set "GN_PORT=%%p"
rem Ouvre le navigateur 2 s plus tard, le temps que le serveur ecoute.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:%GN_PORT%"
echo Groq Nav tourne. Ferme cette fenetre (ou Ctrl+C) pour l'arreter.
node server.js
pause
