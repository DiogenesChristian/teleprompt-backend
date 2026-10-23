@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado no PATH.
  exit /b 1
)

where py >nul 2>nul
if errorlevel 1 (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python nao encontrado no PATH.
    exit /b 1
  )
)

if not exist "backend-node\.env" (
  echo Criando .env do backend a partir do exemplo...
  copy backend-node\.env.example backend-node\.env >nul
)

if not exist "ai-service-python\.venv" (
  echo Criando ambiente virtual do servico de IA...
  cd ai-service-python
  py -m venv .venv
  call .venv\Scripts\python.exe -m pip install -r requirements.txt
  cd ..
)

echo.
echo Iniciando servico de IA...
start "IA-Service" cmd /k "cd /d "%~dp0ai-service-python" && .\.venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000"

timeout /t 3 >nul

echo Iniciando backend...
start "Backend" cmd /k "cd /d "%~dp0backend-node" && npm start"

echo.
echo Backend e IA iniciados.
echo Enderecos:
echo   IA:      http://localhost:8000
ECHO   Backend: http://localhost:4000
