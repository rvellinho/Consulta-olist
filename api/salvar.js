// v9 - Refresh token automático via Supabase
const https = require("https");
const { getAccessToken } = require("./_lib/olist-auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
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

async function salvarAnalise(empresa, chave, dataAnalise, anotacoes, ultimoUsuario) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const payload = JSON.stringify({
    cliente_id: chave,
    empresa,
    data_analise: dataAnalise || null,
    anotacoes: anotacoes || "",
    ultimo_usuario: ultimoUsuario,
    ultima_alteracao: new Date().toISOString(),
  });

  const ru = await httpsRequest("PATCH", supaHost,
    "/rest/v1/analises_credito?cliente_id=eq." + chave + "&empresa=eq." + empresa,
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
    const { id, nome, cpfCnpj, limiteCredito, dataAnalise, anotacoes, ultimoUsuario, empresa } = parsed;
    const empresaChave = String(empresa || "rampa").toLowerCase();

    if (!id) return res.status(400).json({ erro: "id obrigatorio" });

    // Converte valor monetário para número inteiro
    const limiteStr = String(limiteCredito || "0").replace(/\s/g, "");
    const limiteNumero = Math.ceil(parseFloat(limiteStr.replace(/\./g, "").replace(",", ".")) || 0);
    // Regra de negócio: limite zero = mínimo R$ 1,00
    const limiteFormatado = limiteNumero <= 0 ? 1 : limiteNumero;

    // Obtém access token (busca refresh token do Supabase e renova automaticamente)
    const accessToken = await getAccessToken(empresaChave);

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
    await salvarAnalise(empresaChave, chave, dataAnalise, anotacoes, ultimoUsuario);

    return res.status(200).json({ ok: true });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
