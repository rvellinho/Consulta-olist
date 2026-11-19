// getAccessToken(empresa) consolidado — antes duplicado em salvar.js,
// importar.js, estoque.js e ping.js. Busca o refresh token da linha certa em
// tokens_oauth (uma por empresa), renova via OAuth2 e, se a Olist rotacionar
// o refresh token (ela sempre rotaciona), salva o novo de volta no Supabase.
const https = require("https");
const { getConfigEmpresa } = require("./empresas");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }

async function getAccessToken(empresa) {
  const { clientId, clientSecret, tokenOauthId } = getConfigEmpresa(empresa);
  const supaHost = SUPABASE_URL.replace("https://", "");

  const r = await httpsRequest("GET", supaHost,
    `/rest/v1/tokens_oauth?id=eq.${tokenOauthId}&select=token`,
    null, supaHeaders);
  const data = parseJSON(r.text);
  if (!Array.isArray(data) || !data[0]) throw new Error(`Refresh token não encontrado (${tokenOauthId})`);
  const refreshToken = data[0].token;

  const body = "grant_type=refresh_token"
    + "&client_id=" + encodeURIComponent(clientId)
    + "&client_secret=" + encodeURIComponent(clientSecret)
    + "&refresh_token=" + encodeURIComponent(refreshToken);

  const tr = await httpsRequest("POST", "accounts.tiny.com.br",
    "/realms/tiny/protocol/openid-connect/token", body,
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) });
  const td = parseJSON(tr.text);
  if (!td.access_token) throw new Error("Falha ao obter access token: " + tr.text);

  if (td.refresh_token && td.refresh_token !== refreshToken) {
    const p = JSON.stringify({ token: td.refresh_token, atualizado: new Date().toISOString() });
    await httpsRequest("PATCH", supaHost,
      `/rest/v1/tokens_oauth?id=eq.${tokenOauthId}`, p,
      { ...supaHeaders, "Content-Length": Buffer.byteLength(p), Prefer: "return=minimal" });
  }

  return td.access_token;
}

module.exports = { getAccessToken };
