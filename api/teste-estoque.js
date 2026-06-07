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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const token = await getAccessToken();

    // Teste 1: buscar produtos tipo P (produto físico)
    const p1 = new URLSearchParams({ token: TOKEN_V2, pesquisa: " ", tipo: "P", pagina: "1", formato: "JSON" });
    const rProd = await httpsRequest("POST", "api.tiny.com.br", "/api2/produtos.pesquisa.php",
      p1.toString(), { "Content-Type": "application/x-www-form-urlencoded" });
    const dProd = JSON.parse(rProd.text);
    const produtos = dProd.retorno?.produtos?.slice(0, 3) || [];

    await sleep(700);

    // Teste 2: ordens de compra V3 — URL sem "s"
    const rOC = await httpsRequest("GET", "api.tiny.com.br",
      "/public-api/v3/ordem-compra?limit=3",
      null, { Authorization: "Bearer " + token }
    );

    await sleep(700);

    // Teste 3: produto completo para ver campo controlarEstoque
    let prodCompleto = null;
    if (produtos.length > 0) {
      const idProd = produtos[0].produto?.id;
      const p3 = new URLSearchParams({ token: TOKEN_V2, id: idProd, formato: "JSON" });
      const rPC = await httpsRequest("POST", "api.tiny.com.br", "/api2/produto.obter.php",
        p3.toString(), { "Content-Type": "application/x-www-form-urlencoded" });
      prodCompleto = JSON.parse(rPC.text);
    }

    return res.status(200).json({
      produtos_tipo_P: produtos,
      ordens_compra: { status: rOC.status, body: JSON.parse(rOC.text) },
      produto_completo: prodCompleto,
    });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
