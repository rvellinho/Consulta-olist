const https = require("https");

const TOKEN_V2 = process.env.OLIST_TOKEN;
const CLIENT_ID = process.env.OLIST_CLIENT_ID;
const CLIENT_SECRET = process.env.OLIST_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    "/rest/v1/tokens_oauth?id=eq.olist_refresh_token&select=token",
    null, { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY }
  );
  const data = JSON.parse(r.text);
  const refreshToken = data[0].token;

  const body = "grant_type=refresh_token"
    + "&client_id=" + encodeURIComponent(CLIENT_ID)
    + "&client_secret=" + encodeURIComponent(CLIENT_SECRET)
    + "&refresh_token=" + encodeURIComponent(refreshToken);

  const tr = await httpsRequest("POST", "accounts.tiny.com.br",
    "/realms/tiny/protocol/openid-connect/token", body,
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
  );
  return JSON.parse(tr.text).access_token;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const token = await getAccessToken();

    // Testa 1: buscar produtos (com controle de estoque)
    const p1 = new URLSearchParams({ token: TOKEN_V2, pesquisa: " ", controlarEstoque: "S", pagina: "1", formato: "JSON" });
    const rProd = await httpsRequest("POST", "api.tiny.com.br", "/api2/produtos.pesquisa.php",
      p1.toString(), { "Content-Type": "application/x-www-form-urlencoded" });
    const dProd = JSON.parse(rProd.text);
    const produtos = dProd.retorno?.produtos?.slice(0, 2) || [];

    // Testa 2: buscar ordens de compra V3
    const rOC = await httpsRequest("GET", "api.tiny.com.br",
      "/public-api/v3/ordens-de-compra?situacao=1&limit=5",
      null, { Authorization: "Bearer " + token, "Content-Type": "application/json" }
    );

    // Testa 3: buscar estoque de um produto
    let estoque = null;
    if (produtos.length > 0) {
      const idProd = produtos[0].produto?.id;
      const p3 = new URLSearchParams({ token: TOKEN_V2, id: idProd, formato: "JSON" });
      const rEst = await httpsRequest("POST", "api.tiny.com.br", "/api2/produto.obter.estoque.php",
        p3.toString(), { "Content-Type": "application/x-www-form-urlencoded" });
      estoque = JSON.parse(rEst.text);
    }

    return res.status(200).json({
      produtos_amostra: produtos.slice(0, 2),
      ordens_compra_raw: JSON.parse(rOC.text),
      estoque_amostra: estoque,
    });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
