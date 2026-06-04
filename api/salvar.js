// v6
const https = require("https");

const TOKEN = process.env.OLIST_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "POST", headers }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d, headers: res.headers }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsPatch(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "PATCH", headers }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d, headers: res.headers }));
    });
    req.on("error", reject);
    req.write(body);
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  try {
    const parsed = parseBody(req.body);
    const { id, nome, cpfCnpj, limiteCredito, dataAnalise, anotacoes, ultimoUsuario } = parsed;

    if (!id) return res.status(400).json({ erro: "id obrigatorio", recebido: parsed });

    const limiteNumero = parseFloat(String(limiteCredito).replace(/\./g, "").replace(",", "."));
    const limiteFormatado = isNaN(limiteNumero) ? "0.00" : limiteNumero.toFixed(2);
    const nomeEscapado = String(nome)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    const xml = "<contatos><contato><sequencia>1</sequencia><id>" + id + "</id><nome>" + nomeEscapado + "</nome><limite_credito>" + limiteFormatado + "</limite_credito></contato></contatos>";
    const olistBody = "token=" + TOKEN + "&contato=" + encodeURIComponent(xml) + "&formato=JSON";

    const ro = await httpsPost("api.tiny.com.br", "/api2/contato.alterar.php", olistBody, {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(olistBody, "utf8"),
    });

    const dolist = parseJSON(ro.text);
    if (dolist.retorno && dolist.retorno.status === "Erro") {
      throw new Error(dolist.retorno.erros[0].erro || "Erro Olist");
    }

    const chave = String(cpfCnpj || id).replace(/[.\-\/]/g, "");
    const supaHost = SUPABASE_URL.replace("https://", "");
    const payload = JSON.stringify({
      cliente_id: chave,
      data_analise: dataAnalise || null,
      anotacoes: anotacoes || "",
      ultimo_usuario: ultimoUsuario,
      ultima_alteracao: new Date().toISOString(),
    });

    const ru = await httpsPatch(supaHost, "/rest/v1/analises_credito?cliente_id=eq." + chave, payload, {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Prefer: "return=minimal,count=exact",
    });

    const countHeader = ru.headers["content-range"];
    const naoAtualizou = !countHeader || countHeader === "*/0";

    if (naoAtualizou) {
      await httpsPost(supaHost, "/rest/v1/analises_credito", payload, {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Prefer: "return=minimal",
      });
    }

    return res.status(200).json({ ok: true });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
