# teleprompt-backend

Projeto backend para teleprompter com API Node.js e serviço Python de revisão textual por regras (sem IA generativa).

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


## Voz acompanhando o texto

Veja [alterações, roteiro de testes e demonstração na mentoria](docs/voz-acompanhando-texto.md).

## Segurança antes da publicação

1. Copie `backend-node/.env.example` para `backend-node/.env`.
2. Gere um `JWT_SECRET` aleatório com pelo menos 32 caracteres:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
3. Defina `NODE_ENV=production` e um `EDITOR_CODE` secreto. A criação da conta `Jornalista / Editor` exige esse código.
4. Ajuste `LOGIN_MAX_ATTEMPTS` (padrão 5) e `LOGIN_LOCK_MINUTES` (padrão 15).
5. Configure `CORS_ORIGIN` apenas para os endereços reais do frontend.

Em produção, o backend não inicia quando `JWT_SECRET` é curto/ausente ou `EDITOR_CODE` está vazio.

## Segurança para publicação

Antes de publicar:

1. Gere um segredo JWT forte: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
2. Configure `JWT_SECRET`, `EDITOR_CODE`, `NODE_ENV=production`, `LOGIN_MAX_ATTEMPTS` e `LOGIN_LOCK_MINUTES` em `backend-node/.env`.
3. Em produção o backend não inicia sem um `JWT_SECRET` com pelo menos 32 caracteres nem sem `EDITOR_CODE`.
4. Só o perfil **Jornalista / Editor** pode aprovar roteiros, e o cadastro desse perfil exige o código configurado.
5. Use HTTPS e restrinja `CORS_ORIGIN` aos domínios reais do frontend.

## Revisão textual

A revisão é determinística e baseada em expressões regulares e regras de gramática, repetição e leitura oral. **Não utiliza IA generativa nem envia fatos novos**; as sugestões passam pela decisão humana.
