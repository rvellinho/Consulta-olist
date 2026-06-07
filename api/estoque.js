// Relatório de Estoque — endpoints separados para evitar timeout
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
  if (td.refresh_token) {
    const p = JSON.stringify({ token: td.refresh_token, atualizado: new Date().toISOString() });
    await httpsRequest("PATCH", supaHost,
      "/rest/v1/tokens_oauth?id=eq.olist_refresh_token", p,
      { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p), Prefer: "return=minimal" });
  }
  return td.access_token;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const acao = req.query.acao;

  try {
    // ── AÇÃO: listar todos os produtos ──────────────────────────────
    if (acao === "produtos") {
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
        lista.forEach(p => { if (p.produto) produtos.push({ id: p.produto.id, nome: p.produto.nome }); });
        if (lista.length < 100) break;
        pagina++;
        await sleep(600);
      }
      return res.status(200).json({ produtos });
    }

    // ── AÇÃO: dados completos de um produto ─────────────────────────
    if (acao === "produto") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ erro: "id obrigatorio" });

      // Produto completo (classe_produto, estoque_minimo, sku, unidade)
      const b1 = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
      const r1 = await httpsRequest("POST", "api.tiny.com.br", "/api2/produto.obter.php",
        b1, { "Content-Type": "application/x-www-form-urlencoded" });
      const prod = parseJSON(r1.text).retorno?.produto;
      if (!prod) return res.status(200).json({ ignorar: true, motivo: "produto não encontrado" });

     // Filtra produtos de representação
      if ((prod.localizacao || "").toUpperCase().includes("REPRESENTAÇÃO") ||
          (prod.localizacao || "").toUpperCase().includes("REPRESENTACAO")) {
        return res.status(200).json({ ignorar: true, motivo: "representação" });
      }

      await sleep(400);

      // Estoque físico e reservado
      const b2 = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
      const r2 = await httpsRequest("POST", "api.tiny.com.br", "/api2/produto.obter.estoque.php",
        b2, { "Content-Type": "application/x-www-form-urlencoded" });
      const estoque = parseJSON(r2.text).retorno?.produto;

      const estoqueFisico    = parseFloat(estoque?.saldo || 0);
      const estoqueReservado = parseFloat(estoque?.saldoReservado || 0);

      return res.status(200).json({
        ignorar: false,
        id: prod.id,
        sku: prod.codigo || "",
        nome: prod.nome,
        unidade: prod.unidade || "",
        estoqueFisico,
        estoqueReservado,
        estoqueMinimo: parseFloat(prod.estoque_minimo || 0),
      });
    }

    // ── AÇÃO: ordens de compra pendentes ────────────────────────────
    if (acao === "ordens") {
      const accessToken = await getAccessToken();
      const ordensMap = {};
      let offset = 0;
      const limit = 20;

      while (true) {
        await sleep(400);
        const r = await httpsRequest("GET", "api.tiny.com.br",
          `/public-api/v3/ordem-compra?limit=${limit}&offset=${offset}`,
          null, { Authorization: "Bearer " + accessToken });
        const data = parseJSON(r.text);
        const itens = data.itens || [];
        if (!itens.length) break;

        const pendentes = itens.filter(o => o.situacao === "0" || o.situacao === "3");
        for (const ordem of pendentes) {
          await sleep(400);
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
          await sleep(400);
        }

        if (itens.length < limit) break;
        offset += limit;
        await sleep(500);
      }
      return res.status(200).json({ ordensMap });
    }

    return res.status(400).json({ erro: "acao invalida. Use: produtos, produto, ordens" });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
