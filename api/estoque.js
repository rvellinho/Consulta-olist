// Relatório de Estoque — um único endpoint (acao=relatorio).
//
// Antes isso era dividido em 3 chamadas (produtos/produto/ordens) e o
// frontend fazia um loop produto-a-produto na Olist (600ms de pausa cada,
// ~250 produtos => minutos), porque cada produto precisava ser buscado
// individualmente tanto pra saber se era elegível quanto pra pegar o estoque.
//
// Isso não é mais necessário:
// - Elegibilidade/cadastro já vem pronta de `estoque_catalogo` (populada
//   1x/dia por api/estoque-sync-diario.js) — não bate mais na Olist aqui.
// - Estoque (saldo/reservado/disponível) vem da Olist v3 em lote
//   (`GET /estoque`, até 100 produtos por chamada) em vez de um por um.
// - Compras pendentes vêm da listagem de ordens de compra v3, que já traz
//   os itens embutidos — sem precisar buscar o detalhe de cada ordem.
const https = require("https");
const { getAccessToken } = require("./_lib/olist-auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }

async function buscarCatalogoElegivel(empresa) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  // `estoque_catalogo` agora também guarda produto inativado na Tiny (desde
  // 2026-11-23, pro CMV do módulo Financeiro não perder o custo de um
  // produto descontinuado — ver api/estoque-sync-diario.js). Esse relatório
  // é sobre estoque ATUAL, então continua só com produto ativo.
  const r = await httpsRequest("GET", supaHost,
    `/rest/v1/estoque_catalogo?elegivel=eq.true&ativo=eq.true&empresa=eq.${empresa}&select=produto_id,sku,nome,categoria,fornecedor,unidade,estoque_minimo`,
    null, { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY });
  return parseJSON(r.text);
}

// GET /estoque (v3) — saldo/reservado/disponível de até 100 produtos por
// chamada, paginado. Não filtra por ID, então pagina o catálogo inteiro.
async function buscarEstoqueTodos(accessToken) {
  const mapa = {};
  const limit = 100;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/estoque?limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    const itens = data.itens || [];
    itens.forEach(it => {
      mapa[it.idProduto] = {
        saldo: Number(it.saldo) || 0,
        reservado: Number(it.reservado) || 0,
        disponivel: Number(it.disponivel) || 0,
      };
    });
    const total = data.paginacao?.total ?? itens.length;
    offset += limit;
    if (itens.length < limit || offset >= total) break;
  }
  return mapa;
}

// Soma a quantidade pendente por produto nas ordens de compra em aberto (0)
// e em andamento (3). A listagem já traz os itens embutidos; só busca o
// detalhe de uma ordem específica se, excepcionalmente, vier sem itens.
async function buscarComprasPendentes(accessToken) {
  const mapa = {};
  const limit = 100;
  for (const situacao of ["0", "3"]) {
    let offset = 0;
    while (true) {
      const r = await httpsRequest("GET", "api.tiny.com.br",
        `/public-api/v3/ordem-compra?situacao=${situacao}&limit=${limit}&offset=${offset}`,
        null, { Authorization: "Bearer " + accessToken });
      const data = parseJSON(r.text);
      const ordens = data.itens || [];
      for (const ordem of ordens) {
        let itensOrdem = ordem.itens;
        if (!itensOrdem) {
          console.log(`[estoque] ordem ${ordem.id} veio sem itens na listagem, buscando detalhe`);
          const rd = await httpsRequest("GET", "api.tiny.com.br",
            `/public-api/v3/ordem-compra/${ordem.id}`, null, { Authorization: "Bearer " + accessToken });
          itensOrdem = parseJSON(rd.text).itens || [];
        }
        for (const item of itensOrdem) {
          const idProd = item.produto?.id;
          if (!idProd) continue;
          mapa[idProd] = (mapa[idProd] || 0) + (Number(item.quantidade) || 0);
        }
      }
      const total = data.paginacao?.total ?? ordens.length;
      offset += limit;
      if (ordens.length < limit || offset >= total) break;
    }
  }
  return mapa;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const acao = req.query.acao;
  const empresa = String(req.query.empresa || "rampa").toLowerCase();

  try {
    if (acao === "relatorio") {
      const catalogo = await buscarCatalogoElegivel(empresa);
      if (!catalogo.length) {
        return res.status(200).json({ relatorio: [], catalogoVazio: true });
      }

      const accessToken = await getAccessToken(empresa);
      const [estoqueMap, comprasMap] = await Promise.all([
        buscarEstoqueTodos(accessToken),
        buscarComprasPendentes(accessToken),
      ]);

      const relatorio = catalogo.map(p => {
        const e = estoqueMap[p.produto_id] || { saldo: 0, reservado: 0, disponivel: 0 };
        const emCompra = comprasMap[p.produto_id] || 0;
        const dispMaisCompras = e.disponivel + emCompra;
        const estoqueMinimo = Number(p.estoque_minimo) || 0;
        // Não trava em 0: negativo deixa claro que o produto está acima do
        // estoque mínimo (disp.+compras > EM), não só "sem necessidade".
        const necessidade = estoqueMinimo - dispMaisCompras;
        return {
          id: p.produto_id, sku: p.sku || "", nome: p.nome, unidade: p.unidade || "",
          categoria: p.categoria || "—", fornecedor: p.fornecedor || "—",
          estoqueFisico: e.saldo, estoqueReservado: e.reservado, estoqueDisponivel: e.disponivel,
          emCompra, dispMaisCompras, estoqueMinimo, necessidade,
        };
      });
      relatorio.sort((a, b) => b.necessidade - a.necessidade || a.nome.localeCompare(b.nome));

      return res.status(200).json({ relatorio });
    }

    return res.status(400).json({ erro: "acao invalida. Use: relatorio" });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
