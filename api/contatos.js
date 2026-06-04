const https = require("https");

const TOKEN = process.env.OLIST_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function post(hostname, path, body, headers) {
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

function get(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function patch(hostname, path, body, headers) {
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

function getBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => resolve(parseJSON(d)));
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET" && !req.query.id) {
      const pagina = req.query.pagina || 1;
      const pesquisa = req.query.pesquisa || " ";
      const body = new URLSearchParams({ token: TOKEN, pesquisa, situacao: "A", pagina: String(pagina), formato: "JSON" }).toString();
      const r = await post("api.tiny.com.br", "/api2/contatos.pesquisa.php", body, { "Content-Type": "application/x-www-form-urlencoded" });
      const data = parseJSON(r.text);
      if (data.retorno && data.retorno.status === "Erro") throw new Error(data.retorno.erros[0].erro);
      const lista = (data.retorno && data.retorno.contatos) ? data.retorno.contatos.map(c => c.contato) : [];
      const ids = lista.map(c => c.id);
      let analises = {};
      if (ids.length > 0) {
        const supaHost = SUPABASE_URL.replace("https://", "");
        const ar = await get(supaHost, `/rest/v1/analises_credito?cliente_id=in.(${ids.join(",")})`, { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY });
        const ad = parseJSON(ar.text);
        if (Array.isArray(ad)) ad.forEach(a => { analises[a.cliente_id] = a; });
      }
      return res.status(200).json({ itens: lista, analises });
    }

    if (req.method === "GET" && req.query.id) {
      const body = new URLSearchParams({ token: TOKEN, id: req.query.id, formato: "JSON" }).toString();
      const r = await post("api.tiny.com.br", "/api2/contato.obter.php", body, { "Content-Type": "application/x-www-form-urlencoded" });
      const data = parseJSON(r.text);
      return res.status(200).json({ contato: (data.retorno && data.retorno.contato) ? data.retorno.contato : {} });
    }

    if (req.method === "PUT") {
      const b = await getBody(req);
      const { id, nome, limiteCredito, dataAnalise, anotacoes, ultimoUsuario } = b;
      if (!id) return res.status(400).json({ erro: "id obrigatorio", recebido: b });

      const limiteFormatado = parseFloat(limiteCredito).toFixed(2);
      const xml = "<contatos><contato><id>" + id + "</id><nome>" + nome + "</nome><limite_credito>" + limiteFormatado + "</limite_credito></contato></contatos>";
      const olistBody = new URLSearchParams({ token: TOKEN, contato: xml, formato: "JSON" }).toString();
      const ro = await post("api.tiny.com.br", "/api2/contato.alterar.php", olistBody, { "Content-Type": "application/x-www-form-urlencoded" });
      const dolist = parseJSON(ro.text);
      if (dolist.retorno && dolist.retorno.status === "Erro") throw new Error(dolist.retorno.erros[0].erro || "Erro Olist");

      const payload = JSON.stringify({ cliente_id: String(id), data_analise: dataAnalise || null, anotacoes: anotacoes || "", ultimo_usuario: ultimoUsuario, ultima_alteracao: new Date().toISOString() });
      const supaHost = SUPABASE_URL.replace("https://", "");
      const ru = await patch(supaHost, "/rest/v1/analises_credito?cliente_id=eq." + id, payload, { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal,count=exact" });
      const countHeader = ru.headers["content-range"];
      const naoAtualizou = !countHeader || countHeader === "*/0";
      if (naoAtualizou) {
        await post(supaHost, "/rest/v1/analises_credito", payload, { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Metodo nao permitido" });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
