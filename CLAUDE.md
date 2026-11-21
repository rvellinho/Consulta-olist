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
- **⚠️ Pendência não resolvida (achado 2026-11-20): os crons de `estoque-sync-diario.js`
  e `financeiro.js` (`?acao=sync-diario`) podem nunca estar de fato processando nada.**
  A documentação oficial da Vercel confirma que todo cron dispara via **GET** (nunca
  POST), com o header `x-vercel-cron-schedule` (não existe header `x-vercel-cron` — o
  código destes dois arquivos checa um header que não existe). Só que o handler de
  ambos tem um `if (req.method === "GET") { return status-only }` ANTES da checagem de
  cron/segredo — ou seja, como o cron sempre chega como GET, ele sempre cai nesse
  curto-circuito e nunca chega a processar, independente do header. Se isso for real,
  o que de fato mantém `estoque_catalogo`/`financeiro_mensal` atualizados até hoje tem
  sido só chamada manual (botão "Atualizar Catálogo Agora" da aba Estoque, que faz
  `POST`) ou teste manual — não o cron agendado. **Não foi corrigido ainda** (fora do
  escopo da fusão de arquivos de 2026-11-20, que só preservou o comportamento existente
  pra não arriscar quebrar mais coisa de uma vez) — próxima sessão que tocar nesses dois
  arquivos deveria confirmar com o Rafael se o cron realmente nunca rodou de verdade (dá
  pra checar `ultima_tentativa_em` em `estoque_sync_status`/`financeiro_sync_status` e
  comparar com os horários dos crons no `vercel.json`) e, se confirmado, decidir como
  diferenciar "GET do cron de verdade" de "GET de leitura de status pelo frontend" (ex:
  usar o header `x-vercel-cron-schedule` real em vez do curto-circuito por método, ou
  mover a leitura de status pro frontend pra um `acao` GET separado e deixar o método
  GET "nu" cair direto na lógica de processamento). `api/relatorios.js`
  (`?acao=sync-diario`) não tem esse problema — nunca teve o curto-circuito por GET.

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
e impostos sobre a venda por competência, despesas (incluindo CMV) por caixa** — descasamento
entre os dois mês a mês é esperado, não é bug (ex: CMV pago num mês pode superar a receita
reconhecida por competência nesse mesmo mês).

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
  - Despesas/CMV (`2.xx`/`3.01`/`3.02`/`4.xx`): fonte `contas_pagar`, mês = `dataLiquidacao` (data
    em que foi de fato pago), mesma janela alargada por vencimento.
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
| `financeiro_mensal` | `empresa` + `titulo_tipo` + `titulo_id` | Uma linha por título de contas a receber/pagar já classificado (não pré-somado — ver "Módulo Financeiro (DRE)") |
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
