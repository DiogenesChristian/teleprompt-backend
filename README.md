# teleprompt-backend

Projeto backend-only para teleprompter com API Node.js e serviço Python de IA.

## Estrutura atual

- `backend-node/` — API REST, autenticação, roteiros, WebSocket, Deepgram e rastreador de fala
- `ai-service-python/` — serviço FastAPI para revisão do roteiro
- `start-backend.bat` — inicia backend + IA
- `package.json` — entrada de execução do backend

## Requisitos

- Node.js 20.19+
- Python 3.10+

## Como rodar

No PowerShell, na raiz do projeto:

```powershell
cd "c:\Users\pxxdev\workspace\globo-flow"
Set-ExecutionPolicy -Scope Process Bypass
.\start-backend.bat
```

Isso inicia:

- IA em http://localhost:8000
- backend em http://localhost:4000

## Configuração

Copie o exemplo do backend para `.env` e ajuste os valores sensíveis:

```bash
cd backend-node
copy .env.example .env
```

Valores importantes em `backend-node/.env`:

- `JWT_SECRET`
- `AI_SERVICE_URL=http://localhost:8000`
- `DEEPGRAM_API_KEY` (opcional)
- `MONGODB_URI` (opcional, pode ficar vazio para usar memória local)

## Testes

```bash
cd backend-node
npm test
```

```bash
cd ai-service-python
.\.venv\Scripts\python.exe -m pytest -q
```

## Observação

Esta versão do projeto foi limpa para operar apenas na camada de backend e IA. A interface web e qualquer referência a frontend foram removidas do workspace ativo.
