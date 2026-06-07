// Relatório de Estoque e Reposição
const https = require("https");

const TOKEN_V2 = process.env.OLIST_TOKEN;
const CLIENT_ID = process.env.OLIST_CLIENT_ID;
const CLIENT_SECRET = process.env.OLIST_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }

async function getAccessToken() {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    "/rest/v1/tokens_oauth?id=eq.olist_refresh_token&select=token",
    null, { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY });
  const refreshToken = parseJSON(r.text)[0].token;

  const body = "grant_type=refresh_token"
    + "&client_id=" + encodeURIComponent(CLIENT_ID)
    + "&client_secret=" + encodeURIComponent(CLIENT_SECRET)
    + "&refresh_token=" + encodeURIComponent(refreshToken);

  const tr = await httpsRequest("POST", "accounts.tiny.com.br",
    "/realms/tiny/protocol/openid-connect/token", body,
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) });

  const td = parseJSON(tr.text);
  if (!td.access_token) throw new Error("Falha ao obter access token");

  // Salva novo refresh token se renovado
  if (td.refresh_token) {
    const p = JSON.stringify({ token: td.refresh_token, atualizado: new Date().toISOString() });
    await httpsRequest("PATCH", supaHost,
      "/rest/v1/tokens_oauth?id=eq.olist_refresh_token", p,
      { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p), Prefer: "return=minimal" });
  }
  return td.access_token;
}

// Busca todos os produtos ativos paginados
async function buscarTodosProdutos() {
  const produtos = [];
  let pagina = 1;
  while (true) {
    const body = new URLSearchParams({
      token: TOKEN_V2, pesquisa: " ", situacao: "A",
      pagina: String(pagina), formato: "JSON"
    }).toString();
    const r = await httpsRequest("POST", "api.tiny.com.br",
      "/api2/produtos.pesquisa.php", body,
      { "Content-Type": "application/x-www-form-urlencoded" });
    const data = parseJSON(r.text);
    const lista = data.retorno?.produtos || [];
    if (!lista.length) break;
    lista.forEach(p => { if (p.produto) produtos.push(p.produto); });
    if (lista.length < 100) break;
    pagina++;
    await sleep(600);
  }
  return produtos;
}

// Busca produto completo (retorna classe_produto, estoque_minimo, codigo/SKU)
async function buscarProdutoCompleto(id) {
  const body = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/produto.obter.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  return parseJSON(r.text).retorno?.produto || null;
}

// Busca estoque físico e reservado
async function buscarEstoque(id) {
  const body = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/produto.obter.estoque.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  return parseJSON(r.text).retorno?.produto || null;
}

// Busca todas as ordens de compra Em Aberto (0) e Em Andamento (3)
// e soma quantidades por id de produto
async function buscarOrdensCompra(accessToken) {
  const ordensMap = {};
  let offset = 0;
  const limit = 20;

  while (true) {
    await sleep(500);
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/ordem-compra?limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    const itens = data.itens || [];
    if (!itens.length) break;

    // Filtra apenas Em Aberto (0) e Em Andamento (3)
    const pendentes = itens.filter(o => o.situacao === "0" || o.situacao === "3");

    for (const ordem of pendentes) {
      await sleep(500);
      const rOC = await httpsRequest("GET", "api.tiny.com.br",
        `/public-api/v3/ordem-compra/${ordem.id}`,
        null, { Authorization: "Bearer " + accessToken });
      const oc = parseJSON(rOC.text);
      if (oc.itens) {
        for (const item of oc.itens) {
          const idProd = item.produto?.id;
          if (!idProd) continue;
          ordensMap[idProd] = (ordensMap[idProd] || 0) + (item.quantidade || 0);
        }
      }
    }

    if (itens.length < limit) break;
    offset += limit;
    await sleep(600);
  }
  return ordensMap;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // 1. Obtém access token OAuth2
    const accessToken = await getAccessToken();

    // 2. Busca ordens de compra pendentes (faz isso primeiro pois é mais rápido)
    const ordensMap = await buscarOrdensCompra(accessToken);

    // 3. Busca todos os produtos
    const todosProdutos = await buscarTodosProdutos();

    // 4. Para cada produto, busca dados completos e filtra por classe_produto = P
    const relatorio = [];

    for (const prod of todosProdutos) {
      await sleep(600);

      // Busca produto completo para obter classe_produto, estoque_minimo e SKU
      const prodCompleto = await buscarProdutoCompleto(prod.id);
      if (!prodCompleto) continue;

      // Filtra: apenas produtos físicos (classe_produto = P), ignora serviços (S)
      if (prodCompleto.classe_produto !== "P") continue;

      await sleep(400);

      // Busca estoque físico e reservado
      const estoque = await buscarEstoque(prod.id);

      const estoqueFisico     = parseFloat(estoque?.saldo || 0);
      const estoqueReservado  = parseFloat(estoque?.saldoReservado || 0);
      const estoqueDisponivel = estoqueFisico - estoqueReservado;
      const emCompra          = ordensMap[Number(prod.id)] || 0;
      const dispMaisCompras   = estoqueDisponivel + emCompra;
      const estoqueMinimo     = parseFloat(prodCompleto.estoque_minimo || 0);
      const necessidade       = Math.max(0, estoqueMinimo - dispMaisCompras);

      relatorio.push({
        id:              prod.id,
        sku:             prodCompleto.codigo || "",
        nome:            prodCompleto.nome || prod.nome,
        unidade:         prodCompleto.unidade || "",
        estoqueFisico,
        estoqueReservado,
        estoqueDisponivel,
        emCompra,
        dispMaisCompras,
        estoqueMinimo,
        necessidade,
      });

      await sleep(400);
    }

    // Ordena: necessidade de compra decrescente, depois por nome
    relatorio.sort((a, b) => b.necessidade - a.necessidade || a.nome.localeCompare(b.nome));

    return res.status(200).json({ ok: true, total: relatorio.length, relatorio });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
