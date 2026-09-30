@echo off
rem Installe tout ce qu'il faut pour lancer Groq Nav sous Windows :
rem Node.js (>= 18, fournit npm), Git, les dependances npm et le fichier .env.
rem Double-clic dessus, ou lance "install.cmd" dans une invite de commandes.
rem Pas de blocs entre parentheses volontairement : un PATH contenant
rem "Program Files (x86)" casse l'analyse des blocs if (...) de cmd.
setlocal
cd /d "%~dp0"

echo.
echo === Installation de Groq Nav ===
echo.

rem --- 1. Node.js / npm ---
where node >nul 2>nul
if not errorlevel 1 goto node_found

echo [..] Node.js introuvable, installation via winget...
where winget >nul 2>nul
if errorlevel 1 goto no_winget
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto node_install_failed
rem Le PATH de cette console n'est pas rafraichi par l'installeur :
rem on ajoute le dossier d'installation par defaut a la main.
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto node_restart

:node_found
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if errorlevel 1 goto node_too_old
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v
where npm >nul 2>nul
if errorlevel 1 goto npm_missing
for /f "delims=" %%v in ('npm -v') do echo [OK] npm %%v

rem --- 2. Git (utilise par la section git de l'appli) ---
where git >nul 2>nul
if not errorlevel 1 goto git_found
echo [..] Git introuvable, installation via winget...
where winget >nul 2>nul
if errorlevel 1 goto git_warn
winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto git_warn
set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 goto git_warn
:git_found
for /f "delims=" %%v in ('git --version') do echo [OK] %%v
goto deps

:git_warn
echo [!!] Git n'a pas pu etre installe automatiquement.
echo      L'appli demarrera, mais les boutons git echoueront.
echo      Installe-le depuis https://git-scm.com/download/win

rem --- 3. Dependances npm ---
:deps
echo.
echo [..] Installation des dependances npm...
rem "call" est obligatoire : npm est un script .cmd, sans call ce script
rem s'arreterait net apres npm install.
if exist package-lock.json goto npm_ci
call npm install
goto npm_done
:npm_ci
call npm ci
:npm_done
if errorlevel 1 goto npm_failed
echo [OK] Dependances installees.

rem --- 4. Fichier .env ---
if exist .env goto env_ok
copy /y .env.example .env >nul
echo [OK] .env cree depuis .env.example - renseigne GROQ_API_KEY et/ou LOCAL_API_URL.
goto check
:env_ok
echo [OK] .env deja present, conserve tel quel.

rem --- 5. Verification du code ---
:check
call npm run check --silent
if errorlevel 1 goto check_failed
echo [OK] Verification du code reussie.

echo.
echo === Installation terminee. Lance start.cmd pour demarrer Groq Nav. ===
echo.
pause
exit /b 0

:no_winget
echo [XX] winget n'est pas disponible sur ce PC.
echo      Installe Node.js LTS a la main : https://nodejs.org
echo      Coche "Add to PATH", ferme cette fenetre, puis relance install.cmd.
goto fail

:node_install_failed
echo [XX] L'installation de Node.js via winget a echoue.
echo      Installe-le a la main : https://nodejs.org puis relance install.cmd.
goto fail

:node_restart
echo [!!] Node.js est installe mais pas encore visible dans cette console.
echo      Ferme cette fenetre et relance install.cmd.
goto fail

:node_too_old
for /f "delims=" %%v in ('node -v') do echo [XX] Node.js %%v est trop ancien, il faut la version 18 ou plus.
echo      Mets-le a jour : winget upgrade OpenJS.NodeJS.LTS  (ou https://nodejs.org)
goto fail

:npm_missing
echo [XX] Node.js est present mais npm est introuvable : installation cassee.
echo      Reinstalle Node.js LTS depuis https://nodejs.org
goto fail

:npm_failed
echo [XX] npm install a echoue. Lis le message d'erreur ci-dessus
echo      (souvent : pas d'acces Internet, proxy, ou antivirus).
goto fail

:check_failed
echo [XX] La verification du code a echoue (voir ci-dessus).
goto fail

:fail
echo.
pause
exit /b 1
