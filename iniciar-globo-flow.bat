@echo off
rem Globo Flow - liga back, IA e front de uma vez.
rem Fica na raiz do repositorio teleprompt-backend. O teleprompt-frontend precisa
rem estar clonado na mesma pasta que o teleprompt-backend (lado a lado).
setlocal
rem BASE = pasta que tem teleprompt-backend e teleprompt-frontend
for %%I in ("%~dp0..") do set "BASE=%%~fI\"
cd /d "%BASE%"

if not exist "teleprompt-backend\backend-node" (
  echo Nao achei a pasta teleprompt-backend aqui: %BASE%
  echo A pasta deste repositorio precisa se chamar teleprompt-backend.
  pause
  exit /b 1
)
if not exist "teleprompt-frontend\frontend" (
  echo Nao achei a pasta teleprompt-frontend aqui: %BASE%
  echo Clone o frontend ao lado do backend:
  echo   git clone https://github.com/DiogenesChristian/teleprompt-frontend
  pause
  exit /b 1
)

rem Python: usa "py" se existir; senao "python"
set "PY=python"
where py >nul 2>nul && set "PY=py"

rem Primeira vez: instala o back e cria o .env
if not exist "teleprompt-backend\backend-node\node_modules" (
  echo Instalando o backend pela primeira vez...
  pushd "teleprompt-backend\backend-node"
  call npm install
  popd
)
if not exist "teleprompt-backend\backend-node\.env" (
  copy "teleprompt-backend\backend-node\.env.example" "teleprompt-backend\backend-node\.env" >nul
)

rem Primeira vez: cria o ambiente da IA
if not exist "teleprompt-backend\ai-service-python\.venv\Scripts\python.exe" (
  echo Preparando o servico de IA pela primeira vez...
  pushd "teleprompt-backend\ai-service-python"
  %PY% -m venv .venv
  .venv\Scripts\python -m pip install -r requirements.txt
  popd
)

start "Globo Flow - BACK (porta 4000)" cmd /k "cd /d "%BASE%teleprompt-backend\backend-node" && npm start"
start "Globo Flow - IA (porta 8000)" cmd /k "cd /d "%BASE%teleprompt-backend\ai-service-python" && .venv\Scripts\python -m uvicorn main:app --port 8000"
start "Globo Flow - FRONT (porta 8080)" cmd /k "cd /d "%BASE%teleprompt-frontend\frontend" && %PY% -m http.server 8080"

echo Ligando... o navegador abre em alguns segundos.
timeout /t 4 /nobreak >nul
start "" http://localhost:8080
echo.
echo Pronto. Para desligar, feche as 3 janelas (BACK, IA e FRONT).
timeout /t 5 >nul
