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
    if (body) req.write(body); req.end();
  });
}

async function getAccessToken() {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    "/rest/v1/tokens_oauth?id=eq.olist_refresh_token&select=token",
    null, { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY });
  const refreshToken = JSON.parse(r.text)[0].token;
  const body = "grant_type=refresh_token"
    + "&client_id=" + encodeURIComponent(CLIENT_ID)
    + "&client_secret=" + encodeURIComponent(CLIENT_SECRET)
    + "&refresh_token=" + encodeURIComponent(refreshToken);
  const tr = await httpsRequest("POST", "accounts.tiny.com.br",
    "/realms/tiny/protocol/openid-connect/token", body,
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) });
  return JSON.parse(tr.text).access_token;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const token = await getAccessToken();

    // Busca ordem de compra individual para ver itens
    const rOC = await httpsRequest("GET", "api.tiny.com.br",
      "/public-api/v3/ordem-compra/368160098",
      null, { Authorization: "Bearer " + token });

    await sleep(700);

    // Busca produto com controle de estoque para ver campos
    const p1 = new URLSearchParams({ token: TOKEN_V2, id: "364096764", formato: "JSON" });
    const rProd = await httpsRequest("POST", "api.tiny.com.br", "/api2/produto.obter.php",
      p1.toString(), { "Content-Type": "application/x-www-form-urlencoded" });

    return res.status(200).json({
      ordem_compra_individual: { status: rOC.status, body: JSON.parse(rOC.text) },
      produto_com_estoque: JSON.parse(rProd.text),
    });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
