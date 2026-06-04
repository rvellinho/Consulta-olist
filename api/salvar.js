// v9 - Refresh token automático via Supabase
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
      res.on("end", () => resolve({ status: res.statusCode, text: d, headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "object") return reqBody;
  if (typeof reqBody === "string") return parseJSON(reqBody);
  return {};
}

const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

async function getRefreshToken() {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    "/rest/v1/tokens_oauth?id=eq.olist_refresh_token&select=token",
    null,
    supabaseHeaders
  );
  const data = parseJSON(r.text);
  if (!Array.isArray(data) || !data[0]) throw new Error("Refresh token não encontrado no Supabase");
  return data[0].token;
}

async function saveRefreshToken(newToken) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const payload = JSON.stringify({ token: newToken, atualizado: new Date().toISOString() });
  await httpsRequest("PATCH", supaHost,
    "/rest/v1/tokens_oauth?id=eq.olist_refresh_token",
    payload,
    { ...supabaseHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" }
  );
}

async function getAccessToken() {
  const refreshToken = await getRefreshToken();

  const body = "grant_type=refresh_token"
    + "&client_id=" + encodeURIComponent(CLIENT_ID)
    + "&client_secret=" + encodeURIComponent(CLIENT_SECRET)
    + "&refresh_token=" + encodeURIComponent(refreshToken);

  const r = await httpsRequest(
    "POST",
    "accounts.tiny.com.br",
    "/realms/tiny/protocol/openid-connect/token",
    body,
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
  );

  const data = parseJSON(r.text);
  if (!data.access_token) throw new Error("Falha ao obter access token: " + r.text);

  // Salva novo refresh token se foi renovado
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await saveRefreshToken(data.refresh_token);
  }

  return data.access_token;
}

async function salvarAnalise(chave, dataAnalise, anotacoes, ultimoUsuario) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const payload = JSON.stringify({
    cliente_id: chave,
    data_analise: dataAnalise || null,
    anotacoes: anotacoes || "",
    ultimo_usuario: ultimoUsuario,
    ultima_alteracao: new Date().toISOString(),
  });

  const ru = await httpsRequest("PATCH", supaHost,
    "/rest/v1/analises_credito?cliente_id=eq." + chave,
    payload,
    { ...supabaseHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal,count=exact" }
  );

  const countHeader = ru.headers["content-range"];
  const naoAtualizou = !countHeader || countHeader === "*/0";

  if (naoAtualizou) {
    await httpsRequest("POST", supaHost,
      "/rest/v1/analises_credito",
      payload,
      { ...supabaseHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" }
    );
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  try {
    const parsed = parseBody(req.body);
    const { id, nome, cpfCnpj, limiteCredito, dataAnalise, anotacoes, ultimoUsuario } = parsed;

    if (!id) return res.status(400).json({ erro: "id obrigatorio" });

    // Converte valor monetário para número inteiro
    const limiteStr = String(limiteCredito || "0");
    const limiteNumero = parseInt(limiteStr.replace(/\./g, "").replace(/,/g, "")) || 0;
    // Regra de negócio: limite zero = mínimo R$ 1,00
    const limiteFormatado = limiteNumero <= 0 ? 1 : limiteNumero;

    // Obtém access token (busca refresh token do Supabase e renova automaticamente)
    const accessToken = await getAccessToken();

    // Atualiza limite no Olist via API V3
    const v3Body = JSON.stringify({ nome, limiteCredito: limiteFormatado });
    const ro = await httpsRequest(
      "PUT",
      "api.tiny.com.br",
      "/public-api/v3/contatos/" + id,
      v3Body,
      {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(v3Body),
      }
    );

    if (ro.status >= 400) {
      throw new Error("Olist V3 erro " + ro.status + ": " + ro.text);
    }

    // Salva análise no Supabase usando CNPJ/CPF como chave
    const chave = String(cpfCnpj || id).replace(/[.\-\/]/g, "");
    await salvarAnalise(chave, dataAnalise, anotacoes, ultimoUsuario);

    return res.status(200).json({ ok: true });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
