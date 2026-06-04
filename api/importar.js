// Importação em lote via planilha
const https = require("https");

const CLIENT_ID = process.env.OLIST_CLIENT_ID;
const CLIENT_SECRET = process.env.OLIST_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TOKEN_V2 = process.env.OLIST_TOKEN;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

// Busca refresh token do Supabase e obtém access token V3
async function getAccessToken() {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    "/rest/v1/tokens_oauth?id=eq.olist_refresh_token&select=token",
    null, supaHeaders
  );
  const data = parseJSON(r.text);
  if (!Array.isArray(data) || !data[0]) throw new Error("Refresh token não encontrado");
  const refreshToken = data[0].token;

  const body = "grant_type=refresh_token"
    + "&client_id=" + encodeURIComponent(CLIENT_ID)
    + "&client_secret=" + encodeURIComponent(CLIENT_SECRET)
    + "&refresh_token=" + encodeURIComponent(refreshToken);

  const tr = await httpsRequest("POST", "accounts.tiny.com.br",
    "/realms/tiny/protocol/openid-connect/token", body,
    { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
  );
  const td = parseJSON(tr.text);
  if (!td.access_token) throw new Error("Falha ao obter access token");

  // Salva novo refresh token se renovado
  if (td.refresh_token && td.refresh_token !== refreshToken) {
    const p = JSON.stringify({ token: td.refresh_token, atualizado: new Date().toISOString() });
    await httpsRequest("PATCH", supaHost,
      "/rest/v1/tokens_oauth?id=eq.olist_refresh_token", p,
      { ...supaHeaders, "Content-Length": Buffer.byteLength(p), Prefer: "return=minimal" }
    );
  }
  return td.access_token;
}

// Busca cliente no Olist pelo CNPJ
async function buscarClientePorCnpj(cnpj) {
  const cnpjLimpo = cnpj.replace(/[.\-\/]/g, "").trim();
  const params = new URLSearchParams({
    token: TOKEN_V2, cpf_cnpj: cnpjLimpo, formato: "JSON"
  });
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/contatos.pesquisa.php", params.toString(),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  const data = parseJSON(r.text);
  const contatos = data.retorno?.contatos || [];
  if (!contatos.length) return null;
  return contatos[0].contato;
}

// Atualiza limite no Olist V3
async function atualizarLimite(accessToken, idOlist, nome, limite) {
  const v3Body = JSON.stringify({ nome, limiteCredito: limite <= 0 ? 1 : limite });
  const r = await httpsRequest("PUT", "api.tiny.com.br",
    "/public-api/v3/contatos/" + idOlist, v3Body,
    {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(v3Body),
    }
  );
  return r.status;
}

// Salva análise no Supabase
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
    "/rest/v1/analises_credito?cliente_id=eq." + chave, payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal,count=exact" }
  );
  const naoAtualizou = !ru.headers["content-range"] || ru.headers["content-range"] === "*/0";
  if (naoAtualizou) {
    await httpsRequest("POST", supaHost,
      "/rest/v1/analises_credito", payload,
      { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" }
    );
  }
}

// Converte data DD/MM/AAAA para YYYY-MM-DD
function converterData(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (s.includes("/")) {
    const [d, m, y] = s.split("/");
    return `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }
  if (s.includes("-") && s.length === 10) return s;
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  try {
    const body = parseBody(req.body);
    const { linhas, ultimoUsuario } = body;

    if (!Array.isArray(linhas) || !linhas.length) {
      return res.status(400).json({ erro: "Nenhuma linha enviada" });
    }

    // Obtém access token uma vez para toda a importação
    const accessToken = await getAccessToken();

    const resultados = [];
    let sucesso = 0, erros = 0;

    for (const linha of linhas) {
      const { cnpj, limite, data_analise, anotacoes } = linha;

      if (!cnpj) {
        resultados.push({ cnpj: cnpj || "—", status: "erro", msg: "CNPJ vazio" });
        erros++;
        continue;
      }

      try {
        // Busca cliente no Olist pelo CNPJ
        const cliente = await buscarClientePorCnpj(cnpj);
        if (!cliente) {
          resultados.push({ cnpj, status: "erro", msg: "Cliente não encontrado no Olist" });
          erros++;
          await sleep(600);
          continue;
        }

        const chave = cnpj.replace(/[.\-\/]/g, "");
        const limiteNum = parseInt(String(limite || "0").replace(/\D/g, "")) || 0;
        const dataFormatada = converterData(data_analise);

        // Atualiza limite no Olist
        await atualizarLimite(accessToken, cliente.id, cliente.nome, limiteNum);

        // Salva análise no Supabase
        await salvarAnalise(chave, dataFormatada, anotacoes || "", ultimoUsuario || "Importação");

        resultados.push({ cnpj, nome: cliente.nome, status: "ok", limite: limiteNum, data: dataFormatada });
        sucesso++;

      } catch (e) {
        resultados.push({ cnpj, status: "erro", msg: e.message });
        erros++;
      }

      // Pausa entre requisições para respeitar rate limit do Olist (120 req/min)
      await sleep(600);
    }

    return res.status(200).json({ ok: true, sucesso, erros, resultados });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
