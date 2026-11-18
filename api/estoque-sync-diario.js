// Sincronização diária do cadastro de produtos (nome, categoria, fornecedor,
// estoque mínimo e elegibilidade) pra tabela estoque_catalogo — alimenta a
// aba Estoque com dados que não mudam em tempo real, pra ela não precisar
// perguntar à Olist sobre cada um dos ~250 produtos a cada vez que alguém
// pede o relatório (metade deles é serviço/representação e nem entra no
// relatório — isso aqui evita pagar esse preço de novo em toda consulta).
//
// O plano gratuito da Vercel só permite 1 chamada de cron por dia e tem um
// limite curto de duração por chamada — classificar o catálogo inteiro não
// cabe numa chamada só. Por isso essa função se "auto-encadeia": processa um
// lote, salva o progresso em estoque_sync_status, e dispara ela mesma de
// novo pra continuar o próximo lote — até terminar o catálogo todo, tudo
// ainda dentro da mesma madrugada.
const https = require("https");
const { classificarProduto } = require("./_lib/estoque-classificacao");

const TOKEN_V2 = process.env.OLIST_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const TAMANHO_LOTE = 40; // produtos por execução — folga confortável nos 60s de maxDuration
const MAX_SALTOS = 15;   // trava de segurança contra encadeamento sem fim (cobre até ~600 produtos)
const TRAVADO_APOS_MS = 30 * 60 * 1000; // se "em_andamento" ficar preso, uma nova chamada recomeça do zero

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

async function buscarTodosProdutosAtivos() {
  const produtos = [];
  let pagina = 1;
  while (true) {
    const body = new URLSearchParams({
      token: TOKEN_V2, pesquisa: " ", situacao: "A",
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

async function lerStatus() {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost, "/rest/v1/estoque_sync_status?id=eq.1&select=*", null, supaHeaders);
  return parseJSON(r.text)?.[0] || null;
}

async function salvarStatus(status) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const payload = JSON.stringify(status);
  await httpsRequest("PATCH", supaHost, "/rest/v1/estoque_sync_status?id=eq.1", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
}

async function upsertCatalogo(linhas) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const payload = JSON.stringify(linhas);
  await httpsRequest("POST", supaHost, "/rest/v1/estoque_catalogo?on_conflict=produto_id", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=minimal" });
}

// Remove do catálogo quem não apareceu mais na listagem de produtos ativos
// de hoje (produto inativado/excluído na Olist) — só roda quando a
// sincronização termina o catálogo inteiro com sucesso.
async function limparForaDoCatalogo(idsDoDia) {
  if (!idsDoDia.length) return;
  const supaHost = SUPABASE_URL.replace("https://", "");
  const lista = idsDoDia.join(",");
  await httpsRequest("DELETE", supaHost, `/rest/v1/estoque_catalogo?produto_id=not.in.(${lista})`, null,
    { ...supaHeaders, Prefer: "return=minimal" });
}

// Dispara a continuação sem esperar ela terminar — só garante que o pedido
// saiu antes desta execução devolver sua própria resposta.
function dispararContinuacao(host) {
  return new Promise((resolve) => {
    const [hostname, porta] = host.split(":");
    const req = https.request({
      hostname, port: porta || 443, path: "/api/estoque-sync-diario", method: "POST",
      headers: CRON_SECRET ? { Authorization: "Bearer " + CRON_SECRET } : {},
    }, () => {});
    req.on("error", () => resolve());
    req.end();
    setTimeout(resolve, 300);
  });
}

module.exports = async (req, res) => {
  const vercelCron = req.headers["x-vercel-cron"];
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}` && !vercelCron) {
    return res.status(401).json({ erro: "não autorizado" });
  }

  try {
    let status = await lerStatus();
    const iniciadoHaMuito = status?.em_andamento && status.iniciado_em
      && (Date.now() - new Date(status.iniciado_em).getTime() > TRAVADO_APOS_MS);

    if (!status || !status.em_andamento || iniciadoHaMuito) {
      const todos = await buscarTodosProdutosAtivos();
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
      await salvarStatus(status);
    }

    if (status.saltos >= MAX_SALTOS) {
      status.em_andamento = false;
      status.ultimo_erro = `limite de ${MAX_SALTOS} saltos de segurança atingido com ${status.pendentes.length} produtos ainda pendentes`;
      await salvarStatus(status);
      return res.status(200).json({ ok: false, erro: status.ultimo_erro });
    }

    const lote = status.pendentes.slice(0, TAMANHO_LOTE);
    const resto = status.pendentes.slice(TAMANHO_LOTE);
    const linhas = [];

    for (const prod of lote) {
      await sleep(600);
      const body = new URLSearchParams({ token: TOKEN_V2, id: String(prod.id), formato: "JSON" }).toString();
      const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/produto.obter.php", body,
        { "Content-Type": "application/x-www-form-urlencoded" });
      const p = parseJSON(r.text).retorno?.produto;
      if (!p) continue; // erro pontual (ex: bloqueio momentâneo) — mantém o cadastro anterior, tenta de novo no dia seguinte
      const { elegivel, motivoExclusao } = classificarProduto(p);
      linhas.push({
        produto_id: p.id, sku: p.codigo || "", nome: p.nome,
        categoria: p.categoria || null, fornecedor: p.nome_fornecedor || null, unidade: p.unidade || null,
        estoque_minimo: parseFloat(p.estoque_minimo || 0),
        elegivel, motivo_exclusao: motivoExclusao,
        atualizado_em: new Date().toISOString(),
      });
    }
    if (linhas.length) await upsertCatalogo(linhas);

    status.pendentes = resto;
    status.processados += lote.length;
    status.saltos += 1;

    if (resto.length === 0) {
      await limparForaDoCatalogo(status.ids_do_dia);
      status.em_andamento = false;
      status.concluido_em = new Date().toISOString();
      await salvarStatus(status);
      return res.status(200).json({ ok: true, concluido: true, total: status.total_catalogo });
    }

    await salvarStatus(status);
    await dispararContinuacao(req.headers.host);
    return res.status(200).json({ ok: true, concluido: false, processados: status.processados, restante: resto.length });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
