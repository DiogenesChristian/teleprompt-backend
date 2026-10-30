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
cd teleprompt-backend   # a pasta onde você clonou este repositório
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
- `LIVE_EDIT_ROLES` — funções que podem alterar o texto com o roteiro no ar (padrão: `Jornalista / Editor,Produtor`)
- `LIVE_EDIT_APPROVAL` — o que acontece com a aprovação na edição ao vivo (padrão: `manter-se-editor`)

## Testes

```bash
cd backend-node
npm test
```

```bash
cd ai-service-python
.\.venv\Scripts\python.exe -m pytest -q
```

## Regras de roteiro (decisões da equipe em 29/10/2026)

- **Funções:** Apresentador, Jornalista / Editor e Produtor. A função Operador de teleprompter foi retirada; contas antigas entram como Apresentador.
- **Aprovação:** só Jornalista / Editor aprova (`PUT /api/scripts/:id` recusa com 403).
- **Edição com o roteiro no ar** (alguma tela apresentando): só as funções de `LIVE_EDIT_ROLES`. As outras recebem 403 com `code: 'live-edit'`, e o frontend trava a edição e volta à versão do servidor.
- **Aprovação na edição ao vivo:** com `manter-se-editor`, continua aprovado se quem editou é Jornalista / Editor; senão volta para "Em revisão". Fora do ar, texto novo sempre volta para revisão. Quem decide é o servidor; o frontend mostra o que ele gravou.
- **Duas pessoas salvando ao mesmo tempo:** a versão feita em cima de uma versão antiga é recusada com 409 e a versão atual volta junto, para não apagar o trabalho de ninguém.
- **Avisos às telas abertas:** qualquer mudança de texto, título, ordem, duração ou âncoras de um tópico chega aos teleprompters abertos (`script:updated`).

## Tempo real (WebSocket em `/ws?token=...`)

A lista completa de mensagens está no começo de `backend-node/src/realtime.js`. Resumo:

| Assunto | Mensagens |
|---|---|
| Entrar na sala do roteiro | `join` → `hello` (com `cid` da tela), `presence`, `control` |
| Voz | `speech:start`, áudio binário ou `speech:text`, `speech:stop` → `speech:transcript`, `tracker` |
| Rastreador de fala (`tracker`) | posição (`pos`), tópico atual (`block`, `blockId`, `blockTitle`), leitura em andamento (`reading`), âncoras ditas, improviso e ponte, plano de corte |
| Mudança de última hora | `script:updated` (o rastreador mantém a fala no mesmo ponto do tópico) |
| Espelho / Disaster Recovery | `control:claim`, `control:release`, `mirror:state` → `control` (quem controla; `id: null` = a principal caiu), `mirror:state` |
| Posição de quem apresenta (relay) | `clock`, `position` → `scroll`, `room:state`, `scroll:lost` |

### Voz
- A fala é comparada com o roteiro mesmo com palavras trocadas, puladas, erro de uma letra ou singular/plural (`speech/tracker.js`).
- `reading: true` quando a fala bate com o roteiro: o frontend usa isso para o teleprompter começar a rolar sozinho ("Começar pela voz").
- `blockId` muda quando o apresentador passa para outro tópico: o título no teleprompter acompanha a fala.

### Espelho (Disaster Recovery)
- A tela que controla a leitura manda a posição (`mirror:state`); as outras do mesmo roteiro seguem.
- Se ela cair, todas recebem `control` com `id: null`; a reserva assume no manual. Quem volta depois vira espelho.
