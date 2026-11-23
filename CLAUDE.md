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
- `OLIST_TOKEN` — Olist/Tiny API v2 token (legacy `api2/*.php` endpoints, used for read/search) — conta Rampa.
- `OLIST_CLIENT_ID`, `OLIST_CLIENT_SECRET` — OAuth2 client for Olist/Tiny API v3 (`public-api/v3/*`, used for writes) — conta Rampa.
- `OLIST_TOKEN_TF`, `OLIST_CLIENT_ID_TF`, `OLIST_CLIENT_SECRET_TF` — mesmas credenciais, mas da conta Olist
  da Timbers/Fabrique ("TF"). Ver "Multi-empresa" abaixo.
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
- **`api/estoque.js`** — Stock report, single endpoint (`acao=relatorio`). Used to loop
  product-by-product against Olist (600ms delay × ~250 products ⇒ minutes) because
  eligibility could only be known after fetching each product. Not anymore: cadastro +
  eligibility come from `estoque_catalogo` (Supabase, populated by the daily sync below —
  doesn't touch Olist for that), stock quantities come from Olist v3's `GET /estoque` in
  batches of up to 100 products (paginated — a handful of calls for the whole catalog
  instead of one per product), and pending purchase orders come from `GET /ordem-compra`
  filtered by `situacao`, which already returns each order's line items inline (no
  per-order detail call needed — verified live, see "Erros conhecidos" below). End-to-end:
  ~3-4s instead of minutes.
- **`api/estoque-sync-diario.js`** — Daily cron (see "Rotina diária de estoque" below) that keeps
  `estoque_catalogo` up to date (cadastro + elegibilidade, via `api/_lib/estoque-classificacao.js`)
  — this is the only place that still classifies products one-by-one against Olist v2, since the
  bulk v3 endpoints don't expose the fields (`classe_produto`, `localizacao`, etc.) needed for that.
- **`api/financeiro.js`** — Monta o DRE (`GET ?acao=dre&ano=&mes=&empresa=` ou `&consolidado=true`
  pra somar rampa+tf), devolve o plano de contas (`GET ?acao=plano-contas`) e faz CRUD de
  lançamentos manuais na tabela `financeiro_lancamentos_manuais` (sem `acao`, estilo
  `api/lancamentos.js`). Essas rotas só lêem/agregam dados já sincronizados — nunca batem na
  Olist. **Também contém o cron diário** (`?acao=sync-diario&empresa=`, nunca chamado pelo
  frontend — só pelo cron no `vercel.json`) que mantém `financeiro_mensal` atualizada:
  sincroniza `financeiro_categorias` e classifica cada título de contas a receber/pagar dos
  últimos 2 meses por categoria/competência/caixa, mesmo padrão de checkpoint de
  `api/estoque-sync-diario.js`. Fundido num arquivo só em 2026-11-20 (antes eram dois arquivos,
  `api/financeiro.js` + `api/financeiro-sync-diario.js`) — ver "Limite de Serverless Functions
  (Hobby)" abaixo pro motivo. Ver "Módulo Financeiro (DRE)" abaixo pro resto do detalhe.
- **`api/relatorios.js`** — Relatório de Vendas por Notas Fiscais (aba Relatórios): endpoints
  acionados pela tela (`acao=vendas/entradas/servicos/representacao/aguia/...`, coleta ao vivo
  com barra de progresso no navegador) e leitura do cache já processado (`acao=cache`/
  `cache-salvar`). Coleta compartilhada com o sync diário via `api/_lib/relatorio-coleta.js`.
  **Também contém o cron diário** (`?acao=sync-diario`, nunca chamado pelo frontend — só pelo
  cron no `vercel.json`) que atualiza o cache pros últimos 7 dias sozinho no servidor. Fundido
  num arquivo só em 2026-11-20 (antes eram dois arquivos, `api/relatorios.js` +
  `api/relatorio-sync-diario.js`) — ver "Limite de Serverless Functions (Hobby)" abaixo.
- **`api/usuarios.js`** — CRUD for the `usuarios` table in Supabase (admin-only in the UI).
- **`api/lancamentos.js`** — CRUD for the `contatos_propostas` table in Supabase: manual monthly
  entry of Contatos/Propostas counts per Carteira, shown in the Relatórios tab (admin-only in the
  UI). Unique on `(ano, mes, carteira)` — `POST` rejects duplicates (Postgres code `23505`), `PUT`
  edits by `id`.
- **`api/callback.js`** — One-time OAuth authorization-code → token exchange for initial Olist v3
  setup (manual flow, hits `accounts.tiny.com.br`). Resolve a empresa pelo parâmetro `state` que a
  Tiny devolve no redirect (`?code=...&state=tf`) — sem `state`, assume `rampa`.
- **`api/ping.js`** — Refreshes the Olist v3 OAuth token using the stored refresh token (intended
  to be hit periodically, e.g. via cron, to keep the refresh token from expiring). Aceita
  `?empresa=` (default `rampa`).
- **`api/_lib/empresas.js`** — mapa de credenciais por empresa (`rampa`, `tf`), lê as env vars
  certas pra cada uma e lança erro claro se a empresa pedida ainda não tiver as env vars
  preenchidas.
- **`api/_lib/olist-auth.js`** — `getAccessToken(empresa)` consolidado (ver "Multi-empresa" abaixo).

### Olist v3 OAuth refresh-token flow
O refresh token é persistido na tabela `tokens_oauth` do Supabase — uma linha por empresa
(`id = olist_refresh_token_rampa` / `olist_refresh_token_tf`). `getAccessToken(empresa)`, em
`api/_lib/olist-auth.js`, lê o refresh token certo, troca em
`accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token` e — se a Tiny rotacionou o
refresh token (ela sempre rotaciona) — salva o novo de volta no Supabase.

## Multi-empresa (Rampa + TF)

Esse projeto atende duas contas Olist: **Rampa** (a original) e **TF** (Timbers + Fabrique —
duas marcas que dividem CNPJ e uma única conta Olist). O parâmetro `empresa` (valores: `rampa`
ou `tf`, default `rampa` quando omitido — compatibilidade com chamadas antigas/crons) percorre
toda a stack:

- **Credenciais**: `api/_lib/empresas.js` resolve `empresa` pras env vars certas (`OLIST_TOKEN`
  vs `OLIST_TOKEN_TF`, etc.) e pro id certo em `tokens_oauth`.
- **Backend**: todo endpoint que fala com a Olist ou com uma tabela correlacionada aceita
  `empresa` via query string (GET) ou corpo (POST) e usa `api/_lib/empresas.js` /
  `api/_lib/olist-auth.js` — nunca lê `process.env.OLIST_TOKEN` direto.
- **Supabase**: `estoque_catalogo`, `estoque_sync_status` e `analises_credito` têm uma coluna
  `empresa` (default `'rampa'`) — toda query/upsert nessas tabelas tem que filtrar por ela,
  senão mistura dado das duas contas (ex: `produto_id` é um ID interno da Olist, pode colidir
  entre as duas contas).
- **`usuarios`**: coluna `empresas` (jsonb, ex: `["rampa"]` ou `["rampa","tf"]`) — controla o
  seletor de empresa no frontend.
- **Frontend**: `empresaAtual` (global em `index.html`) guarda a empresa escolhida (tela logo
  após o login, ou direto se o usuário só tiver acesso a uma); todo `fetch` pras rotas acima
  passa `empresa=${empresaAtual}`. A TF está conectada (credenciais configuradas, catálogo
  sincronizado) e a aba Estoque funciona de fato pra ela desde 2026-11-19 — Clientes e
  Importar continuam escondidos quando `empresaAtual !== "rampa"` (código já aceita
  `empresa=tf` nesses endpoints, só não foi habilitado na UI porque essas funções ainda não
  foram pensadas/testadas pra TF). Relatórios/lançamentos continuam Rampa-only de propósito
  (ver decisão do usuário — cross-empresa fica pra depois).
- **Adicionar uma empresa nova**: criar a entrada em `EMPRESAS` (`api/_lib/empresas.js`),
  as env vars `OLIST_TOKEN_<X>`/`OLIST_CLIENT_ID_<X>`/`OLIST_CLIENT_SECRET_<X>`, rodar o fluxo
  OAuth uma vez (via `api/callback.js?state=<x>`) pra gerar o primeiro refresh token, e
  adicionar `<x>` em `EMPRESAS` no frontend (`index.html`).

## Frontend (`index.html`)

Single file containing all CSS and JS inline (~1000 lines). No framework, no modules.

- **Auth/session**: login posts to `/api/contatos?login=&senha=`; the returned `usuario`
  (`{id, login, perfil}`) is cached in `sessionStorage` under `"sessao"` and restored on load.
  If the API call throws (e.g. offline), it falls back to a hardcoded `DEMO_USERS` list and a
  `DEMO` dataset, sets `modoDemo = true`, and shows a "DEMO" badge.
- **Roles (`perfil`)**: `admin`, `analista`, `visualizador`. `visualizador` is read-only (no
  "Análise" column/edit form). Only `admin` sees the "⚙️ Configurações" menu (Usuários +
  Importar, consolidated into one dropdown — see `tab-configuracoes`) and the "💰 Financeiro"
  menu (DRE); Estoque is visible to both `admin` and `analista`.
- **Empresa** (`empresaAtual`, `rampa` ou `tf`): escolhida numa tela própria logo após o login
  (pulada se o usuário só tiver acesso a uma — campo `empresas` do usuário) e trocável sem sair
  do app pelo seletor no cabeçalho. Clientes/Importar ficam escondidos quando a empresa não é
  `rampa` (ver "Multi-empresa" acima). Persistida em `sessionStorage["empresaEscolhida"]`.
- **Tabs** (`mudarAba`): Clientes (default), Usuários, Importar, Estoque, Financeiro/DRE — each
  is a `<div>` toggled via `.hidden`, not separate routes/pages (Usuários/Importar/Financeiro são
  acessadas por menus suspensos — Configurações / Financeiro —, mas continuam sendo as mesmas
  abas internamente).
- **Clientes tab**: paginated (100/page) search against `/api/contatos`; clicking a row opens a
  modal that lazily fetches the live credit limit (`/api/contatos?id=`) and shows/edits the
  matching `analisesBD` entry; saving posts to `/api/salvar`.
- **Importar tab**: client-side CSV/XLSX parsing (column-name matching for `cnpj`, `limite`,
  `data_analise`, `anotacoes`), preview table, then batches of 10 rows posted to `/api/importar`.
- **Estoque tab**: one fetch to `/api/estoque?acao=relatorio` (server does all the Olist calls —
  see `api/estoque.js` above), result rendered directly. Also shows a "Catálogo: X produtos —
  atualizado em ..." line (reads `/api/estoque-sync-diario` via GET) and an "Atualizar Catálogo
  Agora" button (POST to the same endpoint) to force the daily sync on demand, for when a
  product's cadastro changed and the admin doesn't want to wait for the 6am cron. Report is
  filterable/sortable/groupable client-side, and exportable to `.xls` (HTML table trick, not a
  real Excel format).
- **Financeiro/DRE tab** (`aba-financeiro-dre`, admin-only, sem restrição por empresa — funciona
  pra rampa/tf/consolidado independente da empresa escolhida no cabeçalho): filtro de
  empresa/ano/mês, busca `/api/financeiro?acao=dre`, renderiza os blocos do DRE com subtotais
  (Receita Líquida, Lucro Bruto, Resultado Antes de Juros, Lucro Líquido, Resultado do Período) e
  um aviso vermelho quando existem lançamentos "não classificados" (categoria da Tiny não mapeada
  no plano de contas). Botão "+ Lançamento Manual" abre `modal-fin-overlay`, que faz CRUD contra
  `/api/financeiro` (sem `acao`) pros lançamentos que nunca vêm da Olist — ver "Módulo Financeiro
  (DRE)" abaixo.

## Regras críticas da API Olist — LEIA ANTES DE QUALQUER ALTERAÇÃO

### API V2 vs V3
- **Escritas** → sempre API V3 (OAuth2, `public-api/v3/*`) — a V2 NÃO atualiza limite de
  crédito de forma confiável, nunca usar V2 pra isso
- **Leituras**: historicamente sempre V2 (token-based, `api2/*.php`), mas a V3 tem endpoints
  de leitura **em lote** que a V2 não tem — vale usar quando servem:
  - `GET /public-api/v3/estoque` — saldo/reservado/disponível de até 100 produtos por
    chamada, paginado (`limit`/`offset`). Usado em `api/estoque.js`. **Não** devolve
    `classe_produto`, `localizacao`, fornecedor nem estoque mínimo — não serve pra
    classificação de elegibilidade, só pra quantidade
  - `GET /public-api/v3/ordem-compra` filtrado por `situacao` — a listagem já traz os
    `itens` (produto + quantidade) embutidos, sem precisar buscar o detalhe de cada ordem.
    Confirmado ao vivo em produção (2026-11-18): nenhuma ordem veio sem itens na listagem
  - `GET /public-api/v3/produtos` (listar produtos) existe mas **não** tem os campos de
    classificação (`classe_produto`, `localizacao`, fornecedor, estoque mínimo) — por isso
    a sincronização diária do catálogo (`api/estoque-sync-diario.js`) continua usando V2
    produto a produto, não dá pra trocar por esse endpoint
  - Limite de requisição da V3 não é documentado com número fixo (a doc só diz que GET
    tem limite maior que POST/PUT/DELETE, por conta, não por app — ver headers
    `X-RateLimit-*` nas respostas se precisar medir de verdade)

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
- Tabela: `tokens_oauth`, uma linha por empresa (`id = olist_refresh_token_rampa` /
  `olist_refresh_token_tf`)
- `getAccessToken(empresa)` mora só em `api/_lib/olist-auth.js` (consolidado — antes era
  duplicado em `salvar.js`/`importar.js`/`estoque.js`/`ping.js`). Qualquer correção é num
  lugar só agora.

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
  em intervalos curtos (ex: de 5 em 5 min)
- **Uma função NUNCA pode se auto-chamar via HTTP pra continuar processando depois.**
  Testado em produção (2026-11-18): a própria Vercel detecta e bloqueia com
  `508 Loop Detected` depois de alguns saltos — não é falha de rede, é proteção de
  plataforma, documentação pública não deixa isso claro. Pra rotinas longas (ver
  "Rotina diária de estoque"), a saída foi aumentar `maxDuration` e processar tudo
  numa única chamada, com checkpoint de progresso salvo no banco como rede de
  segurança (não como mecanismo de continuação)
- **Logs de runtime no Hobby só ficam disponíveis por 1h** (Pro: 1 dia, Enterprise: 3
  dias). Descoberto em produção (2026-11-19) tentando investigar por que um cron das
  06h não tinha rodado — por volta das 11h40 já não dava mais pra ver nada daquele
  horário. Pra qualquer rotina que roda sem supervisão (cron), isso significa que
  `console.error`/`console.log` sozinhos não servem pra diagnosticar depois — o estado
  de erro precisa ser persistido em algum lugar que não expire (ex: Supabase), não só
  logado. Ver "Falha silenciosa do cron diário" na seção de estoque
- **Limite de Serverless Functions (Hobby): no máximo 12 por deploy.** Descoberto em
  produção (2026-11-20): o deploy do commit que adicionava `api/financeiro.js` +
  `api/financeiro-sync-diario.js` (15º/16º arquivo top-level em `api/`) falhou com
  `errorCode: "exceeded_serverless_functions_per_deployment"` — build passou, só o
  deploy final falhou (o site continuou no ar na versão anterior, não houve downtime).
  Cada arquivo `.js` direto em `api/` (não em `api/_lib/`, que o `_` exclui do roteamento)
  conta uma função. Correção aplicada: fundiu dois pares de arquivo-cron-dedicado +
  arquivo-acionado-pela-tela num arquivo só cada (`api/financeiro.js` ganhou de volta
  `?acao=sync-diario`; `api/relatorios.js` ganhou `?acao=sync-diario`), voltando a 12.
  **Se precisar adicionar outro endpoint novo no futuro, checar a contagem antes**
  (`ls api/*.js | wc -l` deve ficar ≤12) — a alternativa é upgrade pro plano Pro (pago),
  decisão que é sempre do Rafael, nunca automática.
- **Cron diário de estoque/financeiro nunca processava nada (achado e corrigido
  2026-11-20).** A documentação oficial da Vercel confirma que todo cron dispara via
  **GET** (nunca POST), marcado com o header `x-vercel-cron-schedule`. Só que o handler
  de `api/estoque-sync-diario.js` e de `api/financeiro.js` (`?acao=sync-diario`) tinha um
  `if (req.method === "GET") { return status-only }` ANTES de checar se era o cron de
  verdade (e checava um header errado, `x-vercel-cron`, que nem existe) — ou seja, como
  o cron sempre chega como GET, ele sempre caía nesse curto-circuito e nunca processava
  nada, desde que esse código existe. Confirmado em produção comparando
  `ultima_tentativa_em` de `estoque_sync_status`/`financeiro_sync_status` contra os
  horários exatos dos crons no `vercel.json` — nunca bateram, só com horários de teste
  manual. O que mantinha `estoque_catalogo` atualizado até aqui era só o botão "Atualizar
  Catálogo Agora" (POST); o financeiro (novo nesse mesmo dia) nunca tinha rodado pelo
  cron nem uma vez. **Corrigido**: a checagem do header real (`x-vercel-cron-schedule`)
  agora vem ANTES do curto-circuito por método, então o cron passa direto pro
  processamento mesmo chegando como GET — testado ao vivo nos dois arquivos (GET sem o
  header continua só lendo status; GET com o header processa de verdade). `api/relatorios.js`
  (`?acao=sync-diario`) nunca teve esse problema — não tinha esse curto-circuito por GET.
  **Lição**: um `if (req.method === "GET")` bem no topo de um handler que também recebe
  cron merece desconfiança — sempre checar primeiro na documentação do provedor qual
  método e qual header ele realmente usa pra disparar, antes de assumir que "GET = leitura,
  outra coisa = ação" cobre o caso do cron.

---

## Rotina diária de estoque (`api/estoque-sync-diario.js`)

Mantém `estoque_catalogo` (cadastro + elegibilidade de cada produto) atualizado, pra aba
Estoque não precisar reclassificar os ~250 produtos do catálogo (dos quais quase metade é
serviço/representação e nunca entra no relatório) a cada vez que alguém pede o relatório —
só o necessário (quantidade em estoque, ordens de compra) continua sendo buscado em tempo real.

- Roda 1x/dia via cron (09:00 UTC = 06:00 BRT), configurado em `vercel.json`
- **Desenho atual: uma chamada só, sem auto-encadeamento.** Primeira versão tentava a
  função se auto-chamar via HTTP pra continuar depois de estourar o tempo — a Vercel
  bloqueia isso com `508 Loop Detected` depois de alguns saltos (descoberto em produção,
  2026-11-18 — ver "Vercel serverless — limitações"). A solução foi dar fôlego de verdade
  pra função (`maxDuration: 300` no `vercel.json`) e processar o catálogo inteiro (~250
  produtos, ~150-250s de trabalho) numa chamada única.
  - A função salva checkpoint em `estoque_sync_status` a cada `SALVAR_PROGRESSO_A_CADA`
    (hoje 20) produtos processados — isso é rede de segurança, não mecanismo de
    continuação: se o catálogo crescer e não couber mais em 300s, ou a chamada cair no
    meio, uma nova chamada retoma de onde parou (lê `pendentes` do checkpoint) em vez de
    recomeçar do zero
  - Produto que falha ao classificar (ex: bloqueio momentâneo da Olist) volta pro fim da
    fila e tenta de novo até `MAX_TENTATIVAS_POR_PRODUTO` vezes antes de desistir por
    hoje — na primeira versão isso não existia e ~12% do catálogo ficou faltando sem
    nenhum aviso
- Se `em_andamento` ficar travado (ex: uma chamada falhou no meio) sem nenhuma atividade por
  mais de `TRAVADO_APOS_MS` (hoje 36h), a próxima chamada recomeça do zero — busca a lista de
  produtos de novo e reclassifica tudo. Esse prazo é comparado contra a última tentativa
  registrada (`ultima_tentativa_em`), não contra o início do ciclo (`iniciado_em`) — ver bug
  corrigido abaixo ("Catálogo grande não termina em 1 chamada + cron 1x/dia")
- Ao terminar o catálogo inteiro com sucesso, remove de `estoque_catalogo` quem não apareceu
  mais na listagem de produtos ativos do dia (produto inativado/excluído na Olist)
- A regra de classificação (o que é serviço, o que é representação) mora em
  `api/_lib/estoque-classificacao.js` — usada tanto aqui quanto em `api/estoque.js`. Qualquer
  ajuste nessa regra precisa ser feito só ali, nunca duplicado

### Falha silenciosa do cron diário (2026-11-19) e visibilidade de erro
Descoberto: o cron das 09:00 UTC (06:00 BRT) não rodou em 2026-11-19 — `estoque_sync_status`
continuava com o `concluido_em` do dia anterior. Causa raiz não confirmada (os logs da
Vercel no plano Hobby só ficam 1h — ver "Vercel serverless — limitações" — e por volta
das 11h o rastro já tinha sumido), mas o cenário mais provável é a função ter caído numa
exceção **antes** de salvar qualquer status (ex: falha/rate-limit da Olist V2 dentro de
`buscarTodosProdutosAtivos()`), já que o `catch` do handler só fazia `console.log` — nada
era persistido no banco, então uma falha bem no início não deixava rastro nenhum em
lugar consultável depois que o log da Vercel expirava.
- Corrigido: a função agora grava `ultima_tentativa_em` (e `ultimo_erro`, se houver) em
  `estoque_sync_status` a cada chamada, **antes** de qualquer trabalho que possa falhar, e
  de novo no `catch` fatal. Isso dá um rastro persistente no Supabase (consultável a
  qualquer hora, sem depender da retenção curta de log da Vercel) de quando a função foi
  chamada por último e se deu erro — mesmo que a falha seja na primeira linha.
- A aba Estoque mostra esse erro: se a última tentativa for mais recente que a última
  conclusão e tiver `ultimo_erro`, a linha "Catálogo: ..." fica vermelha e mostra a
  mensagem de erro em vez de só repetir a data da última sincronização bem-sucedida (que
  antes parecia "tudo normal" mesmo com o cron quebrado há dias)
- **Lição**: qualquer rotina que roda sem ninguém olhar (cron) precisa persistir seu
  próprio estado de erro num lugar que sobrevive à expiração do log — não dá pra confiar
  só em `console.error`/logs da Vercel pra diagnosticar depois no Hobby

### Catálogo grande não termina em 1 chamada + cron 1x/dia → nunca terminava (2026-11-19)
Descoberto ao conectar a TF: o catálogo dela tem 644 produtos (vs. ~250-280 da Rampa), não
cabe no orçamento de uma chamada (`ORCAMENTO_TOTAL_MS`, folga sob os 300s de
`maxDuration`) — precisou de 3 chamadas manuais seguidas pra terminar a primeira vez.

Isso por si só é esperado (ver "retoma de onde parou" acima) — o problema é que o Hobby só
dispara o cron 1x/dia, e a trava de "travado" (`TRAVADO_APOS_MS`) comparava com
`iniciado_em` (início do ciclo inteiro), não com a última atividade. Como o intervalo entre
dois disparos do cron é sempre ~24h, **qualquer** execução incompleta de um dia seria vista
como "travada" no disparo do dia seguinte e recomeçava do zero — pra um catálogo que precisa
de várias chamadas, isso significa nunca terminar (processa os primeiros ~280 produtos todo
dia, reseta, de novo, pra sempre). Não é bug visível de cara: só aparece quando o catálogo
de alguma empresa cresce além do que uma chamada dá conta.

- Corrigido em `api/estoque-sync-diario.js`: a comparação de "travado" agora usa
  `ultima_tentativa_em` (atualizado a cada chamada, inclusive as que só retomam) em vez de
  `iniciado_em`, e `TRAVADO_APOS_MS` subiu de 30 minutos pra 36 horas — folga suficiente pro
  cron diário retomar normalmente de um dia pro outro, mas ainda autorrecupera se a execução
  for realmente abandonada por mais de um dia e meio.
- **Lição**: qualquer limite de "tempo parado = travado" precisa ser maior que o intervalo
  real entre as chamadas que fazem esse trabalho continuar — um cron 1x/dia com um job que
  pode levar mais de um dia pra terminar precisa de uma margem bem acima de 24h, não de
  minutos.

---

## Módulo Financeiro (DRE) (`api/financeiro.js` — DRE/CRUD e `?acao=sync-diario` no mesmo arquivo)

DRE gerencial pra Rampa e TF (balanço/fluxo de caixa ficam pra depois — este módulo cobre só o
DRE). Prioridade explícita do usuário; decisão dele sobre regime contábil (2026-11-20): **receitas
e impostos sobre a venda por competência, despesas por caixa** — descasamento entre os dois mês a
mês é esperado, não é bug. **Exceção, desde 2026-11-21**: CMV (grupo `4.01`) é por competência
também (mês da nota de venda emitida), não por caixa — ver "CMV real" abaixo pro motivo (compra
paga não é o custo da venda).

- **Plano de contas** (`financeiro_plano_contas`, ~16-20 linhas, seed manual): mapeia
  `codigo_grupo` (ex: `"2.06"`) pra uma `linha_dre` (slug usado por `api/financeiro.js` pra montar
  os blocos do DRE, na ordem certa) e um `regime` (`competencia`/`caixa`/`manual`). Os grupos
  `6.01`/`6.02` (Entradas/Saídas) têm `entra_dre=false` — nunca aparecem no relatório, mas existem
  pra não travar um futuro fluxo de caixa.
- **Categorias da Tiny** (`financeiro_categorias`, cache de `GET /categorias-receita-despesa`,
  sincronizada 1x/dia): cada categoria tem `codigo_grupo` (extraído por regex do campo `grupo` da
  Tiny) e um flag `forca_manual`. **Grupos/categorias que NUNCA são puxados automaticamente da
  Tiny, mesmo que existam lançamentos lá** (apuração não-mensal ou valor que precisa de
  estimativa, não o dado bruto):
  - `financeiro_plano_contas.regime='manual'` no grupo `5.02` (Impostos sobre o resultado —
    IRPJ/CSLL são apurados trimestralmente; um pull mensal bruto distorceria o DRE).
  - `financeiro_categorias.forca_manual=true` nas categorias de provisão (inadimplência, 13º
    salário, depreciação) dentro de grupos que por outro lado sincronizam normal.
  - Pra esses casos, o lançamento é sempre manual via `financeiro_lancamentos_manuais`
    (`codigo_grupo` + `subitem` livre, ex: `"Provisão"` vs `"Ajuste"` dentro do grupo `5.02`).
- **Fonte de cada grupo** (`financeiro_plano_contas.fonte_tiny`): `GET /caixa` (lançamentos de
  caixa da Olist) devolve **403 com a conexão OAuth atual** — testado ao vivo, o token de acesso
  não tem nenhuma role de caixa/extrato entre as 48 liberadas (é permissão de app, só o Rafael
  resolve isso ampliando o escopo no painel da Tiny). Por isso:
  - Receita (`1.01`-`1.03`): fonte `contas_receber`, mês = **data de emissão** (`dataCompetencia`
    nunca vem preenchida em contas a receber na prática — confirmado ao vivo em vários títulos
    pagos; emissão já é a competência de uma venda).
  - Imposto sobre venda (`5.01`): fonte `contas_pagar`, mês = `dataCompetencia` real do título
    (essa sim vem preenchida em contas a pagar), buscado numa janela alargada por vencimento
    (±1 mês) porque vencimento pode ficar longe da competência real.
  - Despesas (`2.xx`/`3.01`/`3.02`): fonte `contas_pagar`, mês = `dataLiquidacao` (data em que
    foi de fato pago), mesma janela alargada por vencimento.
  - CMV/Estoques (`4.01`): fonte `notas_fiscais_itens` — **não** vem de `contas_pagar` desde
    2026-11-21 (ver "CMV real" abaixo). Insumos de Serviços (`4.02`) continua `regime='manual'`,
    sem fonte automática — só lançamento manual, igual antes.
- **`financeiro_mensal`**: uma linha por título (não por categoria somada) — chave única
  `(empresa, titulo_tipo, titulo_id)`. A soma por categoria/mês é feita em tempo de leitura em
  `api/financeiro.js`, nunca gravada pré-somada. **Isso não é acidental** — ver "Bug de
  acumulação" abaixo pro motivo de ter sido desenhado assim.
- **Classificação por histórico (stopgap, 2026-11-20)**: pra título de contas a pagar com
  `categoria: null` na Tiny (categoria nova, criada depois do lançamento — caso real: categorias
  de imposto só foram cadastradas em 2026-11-20, títulos pagos antes ficam sem categoria pra
  sempre até alguém retaguear manualmente), o sync diário (`api/financeiro.js`,
  `?acao=sync-diario`) casa o texto do campo `historico` do título contra padrões (`PIS`, `COFINS`, `ICMS`, `ISS`/`ISSQN`, `SIMPLES
  NACIONAL`) e classifica como grupo `5.01` mesmo sem categoria real, gravando com
  `origem='tiny_historico'` (valor específico pra isso em `financeiro_mensal.origem`, distinto de
  `tiny_caixa`/`tiny_competencia`/`manual`) — fica visualmente distinguível de uma classificação
  oficial da Tiny. **Escopo deliberadamente restrito ao grupo `5.01`** — nunca estender esse
  mecanismo pro grupo `5.02`, que é manual por desenho. Auto-corretivo: quando a categoria for
  corrigida na Tiny, o próximo sync substitui a linha pela classificação real (idempotente por
  `titulo_id`), sem precisar de script de limpeza.
- Roda 1x/dia por empresa via cron (`vercel.json`), mesmo padrão de checkpoint/retomada de
  `api/estoque-sync-diario.js` (`ORCAMENTO_TOTAL_MS`, `MAX_TENTATIVAS_POR_TITULO`,
  `SALVAR_PROGRESSO_A_CADA`, `TRAVADO_APOS_MS`). Reprocessa sempre os 2 últimos meses (mês
  corrente + anterior), não assume mês fechado como imutável. Volume medido ao vivo pra Rampa
  (2026-11-20): ~1150 títulos pra reprocessar 2 meses, ~200s de trabalho — precisa de várias
  chamadas por dia pra terminar (TF ainda não medido).

### CMV real: nota de venda × custo do produto, não compra paga (2026-11-21)
Desenho original (v1, 2026-11-20) sourceava `4.01`/`4.02` de `contas_pagar` por caixa — ou seja,
"CMV" era na prática "quanto se pagou de fornecedor no mês". **Errado por desenho, não bug**:
corrigido a pedido explícito do Rafael (compra não é o custo da venda; produto comprado em
outubro pode só ser vendido em dezembro). Produziu ~R$627 mil de "CMV" incorreto pra Rampa
(out+nov/2026) que foi apagado de `financeiro_mensal` na correção.

- **Cálculo**: pra cada nota de venda (tipoNota=S, API V2) emitida dentro da janela de 2 meses
  reprocessada, soma `quantidade × custo` de cada item (`nota.fiscal.obter.php` →
  `itens[].item.{id_produto,quantidade}`). Grava uma linha em `financeiro_mensal` por nota
  (`titulo_tipo='cmv'`, `titulo_id=<id da nota>`, `origem='tiny_notas_itens'`), mês = emissão da
  nota (mesma base da receita, pra Lucro Bruto bater).
- **Custo do produto (desde 2026-11-22, substitui o desenho original que buscava
  `preco_custo` direto na Tiny a cada item)**: nunca bate na Tiny durante o sync do financeiro —
  lê `estoque_catalogo.custo_atual` (já populado pela sincronização diária de estoque, de graça,
  no mesmo `produto.obter.php` usado pra classificação — ver "Rotina diária de estoque"). Motivo:
  buscar custo ao vivo a cada sync fazia o CMV de um mês **já fechado** mudar retroativamente
  sempre que alguém corrigia o custo de um produto na Tiny depois. Por isso existe
  `financeiro_custo_mensal` (`empresa+produto_id+ano+mes`, insert `ignore-duplicates`, nunca
  `merge`): a primeira vez que um produto aparece no "mês anterior" (dos 2 da janela), o custo
  daquele momento é congelado ali e nunca mais muda pra aquele mês; o "mês atual" (mais recente da
  janela) sempre usa `custo_atual` ao vivo. `obterCustoProduto(idProduto, ano, mes)` em
  `api/financeiro.js` decide entre os dois.
- **Só cobre o grupo `4.01` (Estoques)** — mercadoria física vendida. **Não cobre `4.02` (Insumos
  de Serviços)**: não existe hoje uma forma confiável de ligar "material gasto numa nota de
  serviço" a produtos/custo; `4.02` continua `regime='manual'`, sem automação. Se precisar
  automatizar isso no futuro, é um desenho novo, separado deste.
- **Produto sem custo cadastrado conta como custo R$0 nesse item** (não trava o cálculo da nota
  inteira) — o sync loga quantos itens de cada lote ficaram sem custo
  (`checkpoint (cmv): X/Y — N/M itens sem custo cadastrado neste lote`). **Testado ao vivo em
  2026-11-21: Rampa com 0 produtos com `preco_custo`/`preco_custo_medio` cadastrado em qualquer
  venda recente (CMV = R$0,00 em 256 notas) — TF já tem custo cadastrado em parte do catálogo
  (CMV = R$3.835,85 em 260 notas, não-zero)** — pra Rampa, enquanto isso não mudar, o CMV aparece
  como R$0 no DRE (subestimado, não estimado errado); pra TF, o valor já reflete parcialmente a
  realidade, mas ainda subestimado enquanto nem todo produto tiver custo cadastrado. O cadastro de
  custo é manual, direto na Tiny (tela do produto, ou um import de planilha se o Tiny tiver essa
  opção na própria interface) — **não existe endpoint de
  API (nem v2 nem v3) pra escrever `preco_custo`**, confirmado na documentação oficial da v3
  (`PUT /produtos/{id}/preco` só aceita `preco`/`precoPromocional`). A leitura funciona normal
  pelas duas versões.
- **Congelamento por mês, mesma regra de reprocessamento de 2 meses**: enquanto um mês está
  dentro da janela (atual + anterior), o CMV é recalculado a cada sync com o custo que estiver na
  Tiny **naquele dia**; quando o mês sai da janela, nunca mais é tocado — fica congelado no
  último valor calculado enquanto ainda estava na janela (não exatamente no último dia do mês,
  mas pouco depois, dentro do mês seguinte). Decisão explícita do Rafael: evita que cadastrar um
  custo novo mude retroativamente o resultado de um mês já fechado há mais de 2 meses.
- **Migration necessária** (já aplicada em produção): `financeiro_mensal.titulo_tipo` e
  `financeiro_mensal.origem` tinham `CHECK` restringindo os valores aceitos — precisou adicionar
  `'cmv'` e `'tiny_notas_itens'` às listas permitidas. `financeiro_plano_contas.fonte_tiny`
  também tinha `CHECK`, precisou adicionar `'notas_fiscais_itens'`.

#### Bug: falha passageira da Tiny virava "custo zero" (corrigido, 2026-11-22)
`buscarDetalheNotaVendaV2` e `buscarCustoProdutoV2` não checavam `retorno.status === "Erro"` —
se a Tiny respondesse HTTP 200 com um erro no corpo (instabilidade, rate-limit momentâneo), o
código simplesmente não achava `retorno.nota_fiscal`/`retorno.produto`, e `custo` virava `0`
silenciosamente, sem lançar exceção e **sem entrar na fila de retentativa** (`filaCmv`/
`MAX_TENTATIVAS_POR_TITULO`, que só é acionada por exceção). Visto em produção: a contagem de
notas com CMV zerado mudava a cada sync (12 → 31 → 28 em Rampa, por exemplo) mesmo com o
catálogo de custos estável — um script de diagnóstico (consultando os mesmos produtos/notas
direto na Tiny) não achou nenhum produto de verdade sem custo entre os que apareciam zerados.
Piorou porque um script de debug bateu na mesma conta/token da Tiny ao mesmo tempo que o sync de
produção, aumentando a chance de a Tiny recusar/atrasar alguma chamada pontual.
- **Corrigido**: as duas funções agora checam `retorno.status === "Erro"` e lançam exceção
  (mesmo padrão que `listarNotasVendaV2` já usava) — o erro propaga pro `catch` em
  `executarSyncDiario` que devolve a nota pra `filaCmv` (até `MAX_TENTATIVAS_POR_TITULO` vezes),
  em vez de gravar CMV subestimado de forma permanente.
- **Lição**: o mesmo padrão de "resposta HTTP 200 com erro no corpo" que já tinha mordido outras
  partes do projeto (ver `listarNotasVendaV2`, que já tratava isso) apareceu de novo em código
  novo que não seguiu o padrão — ao escrever uma chamada nova pra Tiny, sempre checar
  `retorno.status === "Erro"` explicitamente, nunca confiar que um campo ausente no JSON (ex:
  `produto` ausente) significa "sem custo"/"vazio" em vez de "a chamada falhou".

#### Bug: produto inativado na Tiny perdia o custo no CMV (corrigido, 2026-11-23)
`estoque_catalogo` só guardava produto **ativo** (`situacao=A` na busca de
`api/estoque-sync-diario.js`) — produto inativado/descontinuado na Tiny saía do catálogo (a
limpeza em `limparForaDoCatalogo` existe exatamente pra isso) e `custo_atual` deixava de existir
pra ele. Problema: o CMV usa esse valor pra **qualquer mês da janela de 2 meses**, incluindo
vendas feitas quando o produto ainda estava ativo — um produto vendido em outubro e inativado
depois (ex: antes do fechamento de outubro acontecer) virava custo R$0 no CMV daquele mês, por
estar inativo **hoje**, não por estar sem custo cadastrado. Achado ao vivo (Rampa, 2026-11-23):
`PJO221114`/`PJO221117`, ambos com `preco_custo` cadastrado normal na Tiny (`situacao: "I"`),
ficaram de fora do catálogo e contaram R$0 de custo em 3 notas de outubro.
- **Corrigido**: `api/estoque-sync-diario.js` agora busca `situacao=A` **e** `situacao=I`
  (`buscarTodosProdutos`, duas passadas de `produtos.pesquisa.php`) e grava os dois em
  `estoque_catalogo`, com uma coluna nova `ativo` (boolean, migration aplicada em produção)
  marcando qual é qual — `p.situacao === "A"` no retorno do `produto.obter.php` de cada item,
  não o resultado da busca (mais preciso, evita qualquer divergência entre as duas chamadas).
  **Nunca mais remover produto inativo do catálogo** — ele só some de verdade se nem aparecer
  mais em nenhuma das duas buscas (produto excluído de fato).
- **`api/financeiro.js` (`lerCustoAtualCatalogo`) não filtra por `ativo`** — lê todo mundo,
  então o CMV já pega custo de produto inativo automaticamente, sem mudança nenhuma lá.
- **`api/estoque.js` (`buscarCatalogoElegivel`) passou a filtrar `ativo=eq.true`** — a aba
  Estoque é sobre estoque **atual**, então continua só mostrando produto ativo; sem esse filtro
  novo, produto descontinuado passaria a aparecer ali também (regressão que esse filtro evita).
- **Decisão do Rafael**: "esses itens estão inativos hoje, mas estavam ativos em outubro, então
  tem que ter o custo considerado" — situação atual do produto na Tiny não deve retroagir sobre
  o custo de um mês em que ele ainda estava ativo e foi vendido.

### Intercompany Rampa↔TF (2026-11-22)
A Rampa vende pra TF abaixo do custo; em contrapartida a TF paga algumas despesas da Rampa (e,
mais raro, o inverso também acontece). Pedido explícito do Rafael: separar esses lançamentos numa
coluna própria no DRE das duas empresas (**Operacional** vs **Intercompany Rampa↔TF**), sem mudar
o total que já existia (`total = operacional + intercompany` em todo bloco/subtotal — ver
`montarDRE` em `api/financeiro.js`).

- **Receita/CMV da Rampa (grupos `1.01` e `4.01`): automático.** Toda nota de venda da Rampa pro
  cliente TF (cadastro na Tiny da própria Rampa: "TF COMERCIO E SERVICOS LTDA", id `893415936`,
  CNPJ `51.251.441/0001-05`) marca `intercompany=true` sozinho, a cada sync — tanto na receita
  (`d.cliente.id === ID_CLIENTE_TF_NA_RAMPA`) quanto no CMV (`calcularCmvNota` compara o CNPJ do
  cliente da nota contra `CNPJ_TF`). Na tela, esse apontamento aparece como texto fixo
  ("✓ automático" / "Automático — nota de venda pro cliente TF"), sem checkbox — mexer nele na mão
  seria sobrescrito no sync do dia seguinte.
- **Despesas de QUALQUER empresa (`titulo_tipo=pagar`): sempre manual.** Não tem padrão
  confiável pra detectar sozinho (nome de fornecedor varia, não é sempre "TF" no texto) — por
  isso **Rafael pediu que a marcação manual exista simetricamente nas duas empresas** ("vamos
  permitir que na Rampa também possa ser anotado se uma despesa for da TF, então ambas as
  empresas podemos registrar essa informação"). Endpoint `PATCH /api/financeiro?acao=marcar-intercompany`
  (`{empresa, titulo_tipo, titulo_id, intercompany}`) grava direto na linha do `financeiro_mensal`
  já existente — não cria lançamento novo.
- **Por que o sync nunca apaga uma marcação manual**: o upsert do sync diário monta o payload de
  cada título sem o campo `intercompany` nos dois ramos de contas-pagar (`executarSyncDiario`) —
  só `descricao` é sempre recalculado. Como o upsert é `Prefer: resolution=merge-duplicates` (ver
  "Bug de acumulação" abaixo — substitui coluna a coluna, só as que vierem no payload), uma coluna
  de fora do payload fica intocada no conflito. Então marcar manual e depois rodar o sync não
  reseta a marcação — mas **nunca colocar `intercompany` no payload do lote de contas-pagar**, ou
  esse comportamento quebra.
- **Tela** (`index.html`): cada linha de grupo no DRE ganhou um botão 🔍 (`abrirModalTitulos`) que
  abre um modal com o drill-down de títulos daquele grupo/mês/empresa (`acao=titulos`, novo no
  backend) — uma tabela com empresa/tipo/descrição/valor e, só nas linhas de despesa, um checkbox
  (`marcarIntercompany`) que chama o PATCH acima e recarrega o DRE inteiro pra recalcular as
  colunas na hora.
- **Coluna `descricao`** (nome do contato/histórico do título): sempre recalculada a cada sync,
  existe só pra dar contexto na tela de drill-down (não é usada em nenhum cálculo do DRE).
- **Testado ao vivo em 2026-11-22**: 3 ciclos completos do sync (Rampa, 1410/1410 títulos, zero
  erro) e a tela (login → seleção de empresa → Financeiro/DRE → drill-down → marcar/desmarcar
  checkbox, PATCH confirmado e DRE recalculando em tempo real).

### Bug de acumulação em `financeiro_mensal` (corrigido, 2026-11-20)
O desenho original de `financeiro_mensal` era pré-somado (uma linha por categoria/mês, `valor`
já agregado), com o sync acumulando em memória (`acumulado[chave].valor += valor`) e fazendo
upsert a cada checkpoint de 20 títulos. **Quebrou na prática**: o upsert usa `Prefer:
resolution=merge-duplicates`, que **substitui** a coluna `valor` no conflito (é um `SET col =
EXCLUDED.col` coluna-a-coluna), não soma — então cada checkpoint sobrescrevia o total do
checkpoint anterior pra mesma categoria/mês (e o mesmo valeria entre invocações separadas, já
que cada chamada nova do Node começa com o acumulador vazio). Visto ao vivo: receita de
outubro/2026 aparecia como R$8.431,09 em vez do valor real (~R$428 mil). **Lição**: um upsert com
`merge-duplicates` nunca é seguro pra acumular um total em cima de chamadas parciais — ou a
chave é granular o suficiente pra cada upsert ser idempotente por si só (como ficou: uma linha
por título), ou a soma tem que acontecer inteira numa única chamada, nunca em pedaços.

### Bug: janela de busca cortava no dia 28 de todo mês (corrigido, 2026-11-23)
`executarSyncDiario` montava o fim da janela de busca (emissão pra contas a receber, vencimento
pra contas a pagar) com `formatarData(ano, mes, 28)` — dia **fixo**, não o último dia real do
mês. Resultado: títulos emitidos/vencidos nos dias 29, 30 e 31 nunca eram nem buscados na Tiny —
não apareciam nem classificados nem em "não classificado", simplesmente não existiam pro DRE.
Isso afeta todo mês com mais de 28 dias (ou seja, todos exceto fevereiro), toda vez que o sync
roda. Achado ao vivo verificando a receita de outubro/2026 da Rampa direto na Tiny: 8 títulos de
contas a receber emitidos em 29-30/10, R$ 20.700,31, estavam fora da janela e por isso ausentes
do DRE. **Corrigido**: as duas janelas agora usam `ultimoDiaDoMes(ano, mes)` (helper que já
existia, usada em outro lugar do arquivo) em vez do `28` fixo. **Lição**: nunca hardcodar um
número de dia como "fim do mês" — mesmo um "quase sempre certo" como 28 (que só erra em 10 dos 12
meses) é um bug silencioso, porque não dá erro nenhum, só omite dado sem avisar.

### Bug: buraco no cache de Relatórios de Vendas por delete-then-insert não atômico (achado, 2026-11-23)
`salvarNoCache` (`api/_lib/relatorio-coleta.js`) sempre apaga as linhas do período antes de
regravar (`DELETE` seguido de `INSERT`) — pensado pra limpar nota que deixou de valer (devolução
cancelada, pedido que ganhou NF própria). Problema: se a coleta daquele período falhar ou vier
vazia/parcial por qualquer motivo depois do DELETE (timeout da Tiny, aba fechada no meio do loop
pesado no frontend, rate-limit) a janela fica sem nenhuma linha e sem nenhum erro visível na
tela. Achado comparando nota a nota contra a Tiny pra investigar uma reclamação de receita
errada: dois buracos reais no cache "produto" da Rampa — **17 a 22/10/2026** (38 notas, R$
123.854,90) e **12 a 15/11/2026** (18 notas, R$ 66.459,90) — nenhum alerta indicava isso, o
relatório só mostrava menos venda do que existia de verdade. Corrigido re-coletando os dois
períodos manualmente. **Ainda não corrigido (risco que permanece)**: o padrão delete-then-insert
em si — qualquer resync futuro de um período pode abrir o mesmo buraco se falhar no meio. Uma
correção futura precisaria só apagar depois de confirmar que a nova coleta veio não-vazia (ou
comparar contagem antes de trocar).

---

## Estrutura do banco Supabase

| Tabela | Chave | Descrição |
|---|---|---|
| `analises_credito` | CNPJ + `empresa` | Histórico de análises de crédito |
| `tokens_oauth` | `id` (string, `olist_refresh_token_<empresa>`) | Tokens OAuth2 da Olist, uma linha por empresa |
| `usuarios` | `id` | Usuários do sistema (admin, analista, visualizador) + coluna `empresas` (jsonb) |
| `contatos_propostas` | `id` (unique em `ano`+`mes`+`carteira`) | Lançamento manual de Contatos/Propostas por mês/carteira, na aba Relatórios (Rampa-only por enquanto) |
| `estoque_catalogo` | `produto_id` + `empresa` | Cadastro + elegibilidade de cada produto (serviço/representação), atualizado 1x/dia — ver "Rotina diária de estoque" |
| `estoque_sync_status` | `empresa` (uma linha por empresa) | Progresso/estado da rotina diária de estoque (lista de pendentes, saltos, última conclusão, última tentativa e último erro — ver "Falha silenciosa do cron diário") |
| `financeiro_plano_contas` | `codigo_grupo` | Mapeamento grupo→linha do DRE + regime (competência/caixa/manual) + fonte Tiny — seed manual, sem coluna `empresa` (compartilhado) |
| `financeiro_categorias` | `categoria_id` + `empresa` | Cache de `GET /categorias-receita-despesa`, com `codigo_grupo` extraído e flag `forca_manual` |
| `financeiro_mensal` | `empresa` + `titulo_tipo` + `titulo_id` | Uma linha por título de contas a receber/pagar já classificado (não pré-somado — ver "Módulo Financeiro (DRE)"). Colunas `intercompany` (bool, default `false`) e `descricao` (texto) — ver "Intercompany Rampa↔TF" |
| `financeiro_lancamentos_manuais` | `id` | Lançamentos que nunca vêm da Olist (provisões, ajustes) — `codigo_grupo` + `subitem` livre opcional |
| `financeiro_sync_status` | `empresa` (uma linha por empresa) | Progresso/estado da rotina diária financeira, mesmo padrão de `estoque_sync_status` |

- CNPJ é a chave primária preferida (mais estável que IDs internos da Olist)
- CNPJ sempre armazenado limpo (sem `.`, `/`, `-`)
- Toda tabela correlacionada à Olist tem `empresa` (default `'rampa'`) — ver "Multi-empresa"

---

## Perfis de usuário

| Perfil | Permissões |
|---|---|
| `admin` | Acesso total — Clientes, Usuários, Importar, Estoque, Relatórios, Financeiro/DRE |
| `analista` | Clientes (leitura + edição de análise) e Estoque |
| `visualizador` | Clientes (somente leitura) |

---

## Erros conhecidos — não repetir

1. **`limiteCredito` em `dadosAdicionais`** → campo ignorado pela API, limite não atualiza
2. **Usar API V2 para escrever limite** → operação silenciosa, sem erro mas sem efeito
3. **Loop de produtos no serverless** → timeout do Vercel, mover para o frontend
4. **Não salvar novo refresh token após troca** → token expira, OAuth para de funcionar
5. **`tipo: "S"` interpretado como Serviço** → é Simples (variação), não serviço
6. **Upsert com `Prefer: resolution=merge-duplicates` pra acumular um total em cima de
   chamadas parciais** → o upsert SUBSTITUI a coluna no conflito, não soma — cada checkpoint
   sobrescrevia o total do checkpoint anterior (ver "Bug de acumulação" no Módulo Financeiro).
   Granularidade tem que ser fina o suficiente pra cada upsert ser idempotente por si só

---

## Checklist antes de alterar qualquer código de API

- [ ] A operação é leitura ou escrita?
- [ ] Estou usando V2 para leitura e V3 para escrita?
- [ ] O payload V3 tem `limiteCredito` na raiz?
- [ ] Se alterei `getAccessToken()`, foi só em `api/_lib/olist-auth.js`?
- [ ] Limite zero está sendo convertido para R$1,00?
- [ ] Loops pesados estão no frontend, não no serverless?
- [ ] Esse endpoint fala com a Olist ou com uma tabela correlacionada? Se sim, aceita e
      propaga `empresa` (default `"rampa"`), e usa `api/_lib/empresas.js`/`olist-auth.js`?
