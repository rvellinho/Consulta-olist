// Sincronização diária do cadastro de produtos (nome, categoria, fornecedor,
// estoque mínimo e elegibilidade) pra tabela estoque_catalogo — alimenta a
// aba Estoque com dados que não mudam em tempo real, pra ela não precisar
// perguntar à Olist sobre cada um dos ~250 produtos a cada vez que alguém
// pede o relatório (metade deles é serviço/representação e nem entra no
// relatório — isso aqui evita pagar esse preço de novo em toda consulta).
//
// Tentativa inicial: já que o plano gratuito da Vercel só permite 1 cron/dia
// e tem duração curta por chamada, a função se "auto-encadeava" via HTTP
// (uma chamada disparando a próxima). NÃO FUNCIONA — a própria Vercel detecta
// e bloqueia com "508 Loop Detected" depois de alguns saltos (visto em
// produção em 2026-11-18). Solução: aumentar maxDuration (ver vercel.json,
// hoje 300s) e processar o catálogo inteiro numa única chamada. Ainda assim
// salva o progresso periodicamente em estoque_sync_status, então se um dia o
// catálogo crescer demais e não couber mais em 300s, basta chamar de novo —
// ela retoma de onde parou em vez de recomeçar (a menos que já tenha passado
// TRAVADO_APOS_MS, daí recomeça do zero pra não trabalhar com dado velho).
const https = require("https");
const { classificarProduto } = require("./_lib/estoque-classificacao");
const { getConfigEmpresa } = require("./_lib/empresas");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ORCAMENTO_TOTAL_MS = 280000; // folga sob os 300s de maxDuration (vercel.json)
const MAX_TENTATIVAS_POR_PRODUTO = 3; // falhas pontuais (ex: bloqueio momentâneo da Olist) tentam de novo antes de desistir por hoje
const SALVAR_PROGRESSO_A_CADA = 20; // checkpoint no banco, pra não perder tudo se a chamada cair no meio
// Se "em_andamento" ficar preso sem nenhuma atividade por mais que isso, uma
// nova chamada recomeça do zero. Precisa ser bem maior que o intervalo do
// cron diário (~24h): um catálogo grande (ex: TF, 644 produtos) não cabe
// numa chamada só e precisa retomar de um dia pro outro — comparar com
// menos de 24h faria ele recomeçar do zero TODO dia, sem nunca terminar
// (bug encontrado em 2026-11-19 ao conectar a TF, catálogo maior que o da
// Rampa). 36h dá folga pro cron diário retomar normalmente e ainda
// autorrecupera se a execução for realmente abandonada por mais de um dia.
const TRAVADO_APOS_MS = 36 * 60 * 60 * 1000;

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      const chunks = []; res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }

async function buscarTodosProdutosAtivos(empresa) {
  const { tokenV2 } = getConfigEmpresa(empresa);
  const produtos = [];
  let pagina = 1;
  while (true) {
    const body = new URLSearchParams({
      token: tokenV2, pesquisa: " ", situacao: "A",
      pagina: String(pagina), formato: "JSON",
    }).toString();
    const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/produtos.pesquisa.php", body,
      { "Content-Type": "application/x-www-form-urlencoded" });
    const data = parseJSON(r.text);
    const lista = data.retorno?.produtos || [];
    if (!lista.length) break;
    lista.forEach(p => { if (p.produto) produtos.push({ id: p.produto.id, nome: p.produto.nome }); });
    if (lista.length < 100) break;
    pagina++;
    await sleep(600);
  }
  return produtos;
}

async function lerStatus(empresa) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost, `/rest/v1/estoque_sync_status?empresa=eq.${empresa}&select=*`, null, supaHeaders);
  return parseJSON(r.text)?.[0] || null;
}

// Garante que existe uma linha de status pra essa empresa (não faz nada se
// já existir — precisa de uma constraint única em "empresa" pra isso valer).
async function criarStatus(empresa) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const payload = JSON.stringify({ empresa });
  await httpsRequest("POST", supaHost, "/rest/v1/estoque_sync_status?on_conflict=empresa", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=ignore-duplicates,return=minimal" });
}

async function salvarStatus(empresa, status) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const payload = JSON.stringify(status);
  await httpsRequest("PATCH", supaHost, `/rest/v1/estoque_sync_status?empresa=eq.${empresa}`, payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
}

// Registra que a função foi chamada, antes de qualquer trabalho que possa
// falhar — e, se falhar, o erro. Isso fica salvo no Supabase (consultável a
// qualquer hora) em vez de só nos logs da Vercel, que no plano Hobby somem
// depois de 1h — sem isso, uma falha logo no início (antes do status normal
// existir) passava sem deixar nenhum rastro.
async function marcarTentativa(empresa, erro) {
  await criarStatus(empresa);
  const supaHost = SUPABASE_URL.replace("https://", "");
  const campos = { ultima_tentativa_em: new Date().toISOString() };
  if (erro) campos.ultimo_erro = erro;
  const payload = JSON.stringify(campos);
  await httpsRequest("PATCH", supaHost, `/rest/v1/estoque_sync_status?empresa=eq.${empresa}`, payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
}

async function upsertCatalogo(empresa, linhas) {
  if (!linhas.length) return;
  const supaHost = SUPABASE_URL.replace("https://", "");
  const payload = JSON.stringify(linhas.map(l => ({ ...l, empresa })));
  await httpsRequest("POST", supaHost, "/rest/v1/estoque_catalogo?on_conflict=produto_id,empresa", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=minimal" });
}

// Remove do catálogo quem não apareceu mais na listagem de produtos ativos
// de hoje (produto inativado/excluído na Olist) — só roda quando a
// sincronização termina o catálogo inteiro com sucesso.
async function limparForaDoCatalogo(empresa, idsDoDia) {
  if (!idsDoDia.length) return;
  const supaHost = SUPABASE_URL.replace("https://", "");
  const lista = idsDoDia.join(",");
  await httpsRequest("DELETE", supaHost, `/rest/v1/estoque_catalogo?empresa=eq.${empresa}&produto_id=not.in.(${lista})`, null,
    { ...supaHeaders, Prefer: "return=minimal" });
}

module.exports = async (req, res) => {
  const empresa = String(req.query.empresa || "rampa").toLowerCase();

  // Leitura de status (usada pelo botão "Atualizar Catálogo" do frontend pra
  // mostrar quando foi a última sincronização e acompanhar o progresso de uma
  // em andamento) — não dispara processamento, só lê.
  if (req.method === "GET") {
    try {
      const status = await lerStatus(empresa);
      return res.status(200).json({ ok: true, status });
    } catch (e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  const vercelCron = req.headers["x-vercel-cron"];
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}` && !vercelCron) {
    return res.status(401).json({ erro: "não autorizado" });
  }

  const inicioExecucao = Date.now();

  try {
    // Lê o status ANTES de marcar esta tentativa, pra comparar contra a
    // última atividade real (não contra "agora", que marcarTentativa está
    // prestes a gravar) — ver comentário de TRAVADO_APOS_MS acima.
    let status = await lerStatus(empresa);
    const ultimaAtividade = status?.ultima_tentativa_em || status?.iniciado_em;
    const iniciadoHaMuito = status?.em_andamento && ultimaAtividade
      && (Date.now() - new Date(ultimaAtividade).getTime() > TRAVADO_APOS_MS);
    await marcarTentativa(empresa);

    if (!status || !status.em_andamento || iniciadoHaMuito) {
      const todos = await buscarTodosProdutosAtivos(empresa);
      status = {
        em_andamento: true,
        pendentes: todos,
        ids_do_dia: todos.map(p => p.id),
        total_catalogo: todos.length,
        processados: 0,
        saltos: 0,
        iniciado_em: new Date().toISOString(),
        concluido_em: null,
        ultimo_erro: null,
      };
      await salvarStatus(empresa, status);
      console.log(`[estoque-sync:${empresa}] execução nova: ${todos.length} produtos ativos encontrados`);
    } else {
      console.log(`[estoque-sync:${empresa}] retomando execução anterior: ${status.pendentes.length} ainda pendentes`);
    }

    const { tokenV2 } = getConfigEmpresa(empresa);
    const fila = [...status.pendentes];
    let linhasParaSalvar = [];
    let processadosDesdeUltimoCheckpoint = 0;

    while (fila.length > 0 && (Date.now() - inicioExecucao) < ORCAMENTO_TOTAL_MS) {
      const prod = fila.shift();
      await sleep(600);
      let p = null;
      try {
        const body = new URLSearchParams({ token: tokenV2, id: String(prod.id), formato: "JSON" }).toString();
        const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/produto.obter.php", body,
          { "Content-Type": "application/x-www-form-urlencoded" });
        p = parseJSON(r.text).retorno?.produto;
      } catch (erroRede) {
        console.error(`[estoque-sync] erro de rede no produto ${prod.id} (${prod.nome}): ${erroRede.message}`);
      }

      if (!p) {
        const tentativas = (prod.tentativas || 0) + 1;
        if (tentativas <= MAX_TENTATIVAS_POR_PRODUTO) {
          console.error(`[estoque-sync] produto ${prod.id} (${prod.nome}) sem retorno — tentativa ${tentativas}/${MAX_TENTATIVAS_POR_PRODUTO}, volta pra fila`);
          fila.push({ ...prod, tentativas });
        } else {
          console.error(`[estoque-sync] produto ${prod.id} (${prod.nome}) falhou ${tentativas}x — desiste por hoje, tenta de novo amanha`);
        }
      } else {
        const { elegivel, motivoExclusao } = classificarProduto(p);
        linhasParaSalvar.push({
          produto_id: p.id, sku: p.codigo || "", nome: p.nome,
          categoria: p.categoria || null, fornecedor: p.nome_fornecedor || null, unidade: p.unidade || null,
          estoque_minimo: parseFloat(p.estoque_minimo || 0),
          elegivel, motivo_exclusao: motivoExclusao,
          atualizado_em: new Date().toISOString(),
        });
      }

      processadosDesdeUltimoCheckpoint++;
      if (processadosDesdeUltimoCheckpoint >= SALVAR_PROGRESSO_A_CADA) {
        await upsertCatalogo(empresa, linhasParaSalvar);
        linhasParaSalvar = [];
        status.pendentes = fila;
        status.processados = status.total_catalogo - fila.length;
        status.saltos += 1;
        await salvarStatus(empresa, status);
        console.log(`[estoque-sync:${empresa}] checkpoint: ${status.processados}/${status.total_catalogo} processados, ${fila.length} pendentes`);
        processadosDesdeUltimoCheckpoint = 0;
      }
    }

    await upsertCatalogo(empresa, linhasParaSalvar);
    status.pendentes = fila;
    status.processados = status.total_catalogo - fila.length;
    status.saltos += 1;

    if (fila.length === 0) {
      await limparForaDoCatalogo(empresa, status.ids_do_dia);
      status.em_andamento = false;
      status.concluido_em = new Date().toISOString();
      await salvarStatus(empresa, status);
      console.log(`[estoque-sync:${empresa}] concluído: ${status.total_catalogo} produtos classificados em ${Math.round((Date.now() - inicioExecucao) / 1000)}s`);
      return res.status(200).json({ ok: true, concluido: true, total: status.total_catalogo });
    }

    // Orçamento de tempo esgotado antes de terminar o catálogo inteiro — fica
    // salvo como está (em_andamento continua true) pra retomar na próxima
    // chamada em vez de recomeçar do zero.
    await salvarStatus(empresa, status);
    console.error(`[estoque-sync:${empresa}] orçamento de tempo esgotado: ${status.processados}/${status.total_catalogo} processados, ${fila.length} pendentes — precisa de outra chamada pra terminar`);
    return res.status(200).json({ ok: true, concluido: false, processados: status.processados, restante: fila.length });

  } catch (e) {
    console.error(`[estoque-sync:${empresa}] erro fatal:`, e.message);
    try { await marcarTentativa(empresa, e.message); } catch (_) { /* best-effort */ }
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
