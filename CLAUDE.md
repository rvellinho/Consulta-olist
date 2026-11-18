# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

"Rampa · Consultas Olist" — an internal credit-management tool that integrates the Olist Tiny ERP
with a Supabase backend. It is a static single-page frontend (`index.html`) backed by Vercel
serverless functions in `api/`. There is no build step, no bundler, and no npm dependencies
(`package.json` only declares the package name).

## Development / deployment

- No build, lint, or test commands exist in this repo — it deploys to Vercel as-is.
- Local dev: `vercel dev` (requires the Vercel CLI and the env vars below in `.env`/Vercel project settings).
- `vercel.json` sets `memory: 256` for `api/salvar.js` and `api/contatos.js` (these make several
  sequential outbound HTTPS calls and need extra headroom/time).

### Required environment variables
- `OLIST_TOKEN` — Olist/Tiny API v2 token (legacy `api2/*.php` endpoints, used for read/search).
- `OLIST_CLIENT_ID`, `OLIST_CLIENT_SECRET` — OAuth2 client for Olist/Tiny API v3 (`public-api/v3/*`, used for writes).
- `SUPABASE_URL`, `SUPABASE_KEY` — Supabase project URL and service key, used as the app's database via PostgREST.

## Backend (`api/*.js`)

Each file is a standalone Vercel serverless function exporting `module.exports = async (req, res) => {...}`.
They are plain CommonJS using only Node's built-in `https` module — there's a small amount of
duplicated boilerplate across files (`httpsRequest`/`post`/`get`, `parseJSON`, `parseBody`,
`supaHeaders`/`supabaseHeaders`). When fixing a bug in one of these helpers, check the other files
for the same duplicated logic.

- **`api/contatos.js`** — Reads/searches contacts via Olist v2 (`contatos.pesquisa.php`,
  `contato.obter.php`). Also doubles as the login endpoint: `GET /api/contatos?login=&senha=`
  checks `usuarios` table in Supabase (plaintext password match — no hashing). Cross-references
  results with the `analises_credito` Supabase table keyed by cleaned CNPJ/CPF.
- **`api/salvar.js`** — Saves a credit-limit analysis: updates `limiteCredito` on Olist v3
  (`PUT /public-api/v3/contatos/:id`) and upserts a row in Supabase `analises_credito`
  (PATCH first, falls back to POST if no row was updated, based on `Content-Range` header).
  Business rule: a limit of 0 is sent to Olist as 1.
- **`api/importar.js`** — Bulk version of `salvar.js` for spreadsheet imports: looks up each
  client by CNPJ via Olist v2, then updates limit (v3) + analysis (Supabase) per row, with a
  600ms delay between rows to respect Olist's rate limit (120 req/min).
- **`api/estoque.js`** — Stock report, split into separate `acao=` endpoints
  (`produtos`, `produto`, `ordens`) specifically to avoid serverless timeouts — the frontend
  drives the multi-step aggregation (see below). Eligibility classification (serviço/representação)
  comes from `api/_lib/estoque-classificacao.js`, shared with the daily sync below.
- **`api/estoque-sync-diario.js`** — Daily cron (see "Rotina diária de estoque" below) that keeps
  `estoque_catalogo` up to date, so the live stock report only has to ask Olist about products
  already known to be eligible, instead of re-classifying the whole catalog on every load.
- **`api/usuarios.js`** — CRUD for the `usuarios` table in Supabase (admin-only in the UI).
- **`api/lancamentos.js`** — CRUD for the `contatos_propostas` table in Supabase: manual monthly
  entry of Contatos/Propostas counts per Carteira, shown in the Relatórios tab (admin-only in the
  UI). Unique on `(ano, mes, carteira)` — `POST` rejects duplicates (Postgres code `23505`), `PUT`
  edits by `id`.
- **`api/callback.js`** — One-time OAuth authorization-code → token exchange for initial Olist v3
  setup (manual flow, hits `accounts.tiny.com.br`).
- **`api/ping.js`** — Refreshes the Olist v3 OAuth token using the stored refresh token (intended
  to be hit periodically, e.g. via cron, to keep the refresh token from expiring).

### Olist v3 OAuth refresh-token flow
The refresh token is persisted in the Supabase table `tokens_oauth` (row `id=olist_refresh_token`).
`getAccessToken()` (separately implemented in `api/estoque.js`, `api/importar.js`, `api/salvar.js`,
and `api/ping.js`) reads that refresh token, exchanges it at
`accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token`, and — if Tiny rotated the
refresh token — writes the new one back to Supabase. Any change to this flow needs to be applied
in all of these files.

## Frontend (`index.html`)

Single file containing all CSS and JS inline (~1000 lines). No framework, no modules.

- **Auth/session**: login posts to `/api/contatos?login=&senha=`; the returned `usuario`
  (`{id, login, perfil}`) is cached in `sessionStorage` under `"sessao"` and restored on load.
  If the API call throws (e.g. offline), it falls back to a hardcoded `DEMO_USERS` list and a
  `DEMO` dataset, sets `modoDemo = true`, and shows a "DEMO" badge.
- **Roles (`perfil`)**: `admin`, `analista`, `visualizador`. `visualizador` is read-only (no
  "Análise" column/edit form). Only `admin` sees the Usuários, Importar, and Estoque tabs.
- **Tabs** (`mudarAba`): Clientes (default), Usuários, Importar, Estoque — each is a `<div>`
  toggled via `.hidden`, not separate routes/pages.
- **Clientes tab**: paginated (100/page) search against `/api/contatos`; clicking a row opens a
  modal that lazily fetches the live credit limit (`/api/contatos?id=`) and shows/edits the
  matching `analisesBD` entry; saving posts to `/api/salvar`.
- **Importar tab**: client-side CSV/XLSX parsing (column-name matching for `cnpj`, `limite`,
  `data_analise`, `anotacoes`), preview table, then batches of 10 rows posted to `/api/importar`.
- **Estoque tab**: orchestrates the multi-call report — fetches `acao=ordens` and `acao=produtos`
  once, then loops over every product calling `acao=produto&id=` one at a time with a 600ms
  delay (progress bar shown to the user). Results are merged client-side (`estoqueDisponivel`,
  `emCompra`, `dispMaisCompras`, `necessidade`), filterable/sortable/groupable, and exportable to
  `.xls` (HTML table trick, not a real Excel format).

## Regras críticas da API Olist — LEIA ANTES DE QUALQUER ALTERAÇÃO

### API V2 vs V3
- **Leituras** → sempre API V2 (token-based, `api2/*.php`)
- **Escritas** → sempre API V3 (OAuth2, `public-api/v3/*`)
- A API V2 NÃO atualiza limite de crédito de forma confiável — nunca usar V2 para writes

### Payload V3 — campo `limiteCredito`
- O campo `limiteCredito` deve estar na **raiz** do JSON payload
- NUNCA colocar dentro de `dadosAdicionais` — não funciona
- Correto:
```json
  { "limiteCredito": 1500.00 }
```
- Errado:
```json
  { "dadosAdicionais": { "limiteCredito": 1500.00 } }
```

### Regra de negócio — limite zero
- Limites de R$0,00 são SEMPRE enviados à Olist como R$1,00
- Motivo: evitar que clientes apareçam sem restrição no ERP
- Implementado em `api/salvar.js` e `api/importar.js` — manter consistente

### OAuth2 — refresh token
- O refresh token é rotativo — a Olist emite um novo a cada uso
- Sempre salvar o novo refresh token no Supabase após cada troca
- Tabela: `tokens_oauth`, row `id = olist_refresh_token`
- A função `getAccessToken()` existe duplicada em:
  - `api/salvar.js`
  - `api/importar.js`
  - `api/estoque.js`
  - `api/ping.js`
- Qualquer correção nessa função deve ser aplicada nos 4 arquivos

### Rate limit Olist
- Limite: ~120 requisições/minuto
- Aguardar **600ms entre chamadas** em loops (importação, estoque)
- O processamento em loop NUNCA deve rodar no serverless Vercel (timeout)
- Sempre mover loops pesados para o frontend (browser)

### Catálogo de produtos — campo `tipo`
- `tipo: "S"` significa **"Simples"** (variação de produto)
- NÃO significa "Serviço" — erro já cometido anteriormente

### Vercel serverless — limitações
- Timeout curto — funções não podem fazer loops longos
- `api/salvar.js` e `api/contatos.js` têm `memory: 256` no `vercel.json`
- Processamento de relatórios e importações em lote → sempre no frontend
- Plano é o gratuito (Hobby): cron só dispara 1x/dia por rota — não dá pra agendar
  em intervalos curtos (ex: de 5 em 5 min). Rotinas que precisam de várias chamadas
  pra terminar usam auto-encadeamento (ver "Rotina diária de estoque")

---

## Rotina diária de estoque (`api/estoque-sync-diario.js`)

Mantém `estoque_catalogo` (cadastro + elegibilidade de cada produto) atualizado, pra aba
Estoque não precisar reclassificar os ~250 produtos do catálogo (dos quais quase metade é
serviço/representação e nunca entra no relatório) a cada vez que alguém pede o relatório —
só o necessário (quantidade em estoque, ordens de compra) continua sendo buscado em tempo real.

- Roda 1x/dia via cron (09:00 UTC = 06:00 BRT), configurado em `vercel.json`
- **Auto-encadeamento**: como o plano gratuito da Vercel limita a duração de cada chamada
  (hoje `maxDuration: 60`) e só permite cron 1x/dia, a função processa produtos até estourar
  um orçamento de tempo (`ORCAMENTO_MS`, hoje 45s — não é uma quantidade fixa de produtos,
  porque o tempo por produto varia), salva o progresso em `estoque_sync_status` (linha única,
  `id=1`), e dispara ela mesma de novo via HTTP (sem esperar a resposta) pra continuar —
  até terminar o catálogo inteiro, ainda na mesma madrugada. `MAX_SALTOS` é uma trava de
  segurança contra encadeamento sem fim.
  - **Já falhou em silêncio uma vez** (2026-11-18, testado manualmente): o auto-disparo não
    chegou a acionar a próxima chamada, e ficou parado sem erro registrado até alguém notar e
    disparar manualmente. Por isso `dispararContinuacao` loga no console antes/depois de
    disparar — se voltar a travar, checar os runtime logs da Vercel pra esse padrão antes de
    supor que é só lentidão
  - Produto que falha ao classificar (ex: bloqueio momentâneo da Olist) volta pro fim da fila
    e tenta de novo até `MAX_TENTATIVAS_POR_PRODUTO` vezes antes de desistir por hoje — na
    primeira versão isso não existia e ~12% do catálogo ficou faltando sem nenhum aviso
- Se `em_andamento` ficar travado (ex: uma chamada falhou no meio) por mais de 30 minutos,
  a próxima chamada recomeça do zero — busca a lista de produtos de novo e reclassifica tudo
- Ao terminar o catálogo inteiro com sucesso, remove de `estoque_catalogo` quem não apareceu
  mais na listagem de produtos ativos do dia (produto inativado/excluído na Olist)
- A regra de classificação (o que é serviço, o que é representação) mora em
  `api/_lib/estoque-classificacao.js` — usada tanto aqui quanto em `api/estoque.js`. Qualquer
  ajuste nessa regra precisa ser feito só ali, nunca duplicado

---

## Estrutura do banco Supabase

| Tabela | Chave | Descrição |
|---|---|---|
| `analises_credito` | CNPJ (string limpa) | Histórico de análises de crédito |
| `tokens_oauth` | `id` (string) | Tokens OAuth2 da Olist |
| `usuarios` | `id` | Usuários do sistema (admin, analista, visualizador) |
| `contatos_propostas` | `id` (unique em `ano`+`mes`+`carteira`) | Lançamento manual de Contatos/Propostas por mês/carteira, na aba Relatórios |
| `estoque_catalogo` | `produto_id` (id Olist) | Cadastro + elegibilidade de cada produto (serviço/representação), atualizado 1x/dia — ver "Rotina diária de estoque" |
| `estoque_sync_status` | `id` (fixo em `1`) | Progresso/estado da rotina diária de estoque (lista de pendentes, saltos, última conclusão) |

- CNPJ é a chave primária preferida (mais estável que IDs internos da Olist)
- CNPJ sempre armazenado limpo (sem `.`, `/`, `-`)

---

## Perfis de usuário

| Perfil | Permissões |
|---|---|
| `admin` | Acesso total — Clientes, Usuários, Importar, Estoque |
| `analista` | Clientes (leitura + edição de análise) |
| `visualizador` | Clientes (somente leitura) |

---

## Erros conhecidos — não repetir

1. **`limiteCredito` em `dadosAdicionais`** → campo ignorado pela API, limite não atualiza
2. **Usar API V2 para escrever limite** → operação silenciosa, sem erro mas sem efeito
3. **Loop de produtos no serverless** → timeout do Vercel, mover para o frontend
4. **Não salvar novo refresh token após troca** → token expira, OAuth para de funcionar
5. **`tipo: "S"` interpretado como Serviço** → é Simples (variação), não serviço

---

## Checklist antes de alterar qualquer código de API

- [ ] A operação é leitura ou escrita?
- [ ] Estou usando V2 para leitura e V3 para escrita?
- [ ] O payload V3 tem `limiteCredito` na raiz?
- [ ] Se alterei `getAccessToken()`, atualizei os 4 arquivos?
- [ ] Limite zero está sendo convertido para R$1,00?
- [ ] Loops pesados estão no frontend, não no serverless?
