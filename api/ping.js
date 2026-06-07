const https = require("https");

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

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const supaHost = SUPABASE_URL.replace("https://", "");

    // Busca refresh token atual
    const r = await httpsRequest("GET", supaHost,
      "/rest/v1/tokens_oauth?id=eq.olist_refresh_token&select=token",
      null, supaHeaders
    );
    const data = JSON.parse(r.text);
    if (!Array.isArray(data) || !data[0]) throw new Error("Refresh token não encontrado");
    const refreshToken = data[0].token;

    // Renova o token
    const body = "grant_type=refresh_token"
      + "&client_id=" + encodeURIComponent(CLIENT_ID)
      + "&client_secret=" + encodeURIComponent(CLIENT_SECRET)
      + "&refresh_token=" + encodeURIComponent(refreshToken);

    const tr = await httpsRequest("POST", "accounts.tiny.com.br",
      "/realms/tiny/protocol/openid-connect/token", body,
      { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
    );
    const td = JSON.parse(tr.text);
    if (!td.access_token) throw new Error("Falha ao renovar: " + tr.text);

    // Salva novo refresh token
    if (td.refresh_token) {
      const payload = JSON.stringify({ token: td.refresh_token, atualizado: new Date().toISOString() });
      await httpsRequest("PATCH", supaHost,
        "/rest/v1/tokens_oauth?id=eq.olist_refresh_token", payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" }
      );
    }

    return res.status(200).json({ ok: true, renovado: new Date().toISOString() });

  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
};
