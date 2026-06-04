// v4
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

const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

async function buscarUsuario(login, senha) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await get(supaHost,
    `/rest/v1/usuarios?login=eq.${encodeURIComponent(login)}&senha=eq.${encodeURIComponent(senha)}&ativo=eq.true&select=id,login,perfil`,
    supabaseHeaders
  );
  const data = parseJSON(r.text);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

function limparDoc(doc) {
  return String(doc || "").replace(/[.\-\/]/g, "");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ── GET lista ─────────────────────────────────────────────────────────
    if (req.method === "GET" && !req.query.id) {
      const pagina = req.query.pagina || 1;
      const pesquisa = req.query.pesquisa || " ";

      const params = new URLSearchParams({
        token: TOKEN, pesquisa, situacao: "A",
        pagina: String(pagina), formato: "JSON",
      });

      const r = await post("api.tiny.com.br", "/api2/contatos.pesquisa.php", params.toString(), { "Content-Type": "application/x-www-form-urlencoded" });
      const data = parseJSON(r.text);
      if (data.retorno && data.retorno.status === "Erro") throw new Error(data.retorno.erros[0].erro);

      const lista = (data.retorno && data.retorno.contatos) ? data.retorno.contatos.map(c => c.contato) : [];

      // Busca análises por CNPJ/CPF
      const chaves = lista.map(c => limparDoc(c.cpf_cnpj)).filter(Boolean);
      let analises = {};

      if (chaves.length > 0) {
        const supaHost = SUPABASE_URL.replace("https://", "");
        const ar = await get(supaHost, "/rest/v1/analises_credito?cliente_id=in.(" + chaves.join(",") + ")", {
          apikey: SUPABASE_KEY,
          Authorization: "Bearer " + SUPABASE_KEY,
        });
        const ad = parseJSON(ar.text);
        if (Array.isArray(ad)) ad.forEach(a => { analises[a.cliente_id] = a; });
      }

      return res.status(200).json({ itens: lista, analises });
    }

    // ── GET individual ────────────────────────────────────────────────────
    if (req.method === "GET" && req.query.id) {
      const params = new URLSearchParams({ token: TOKEN, id: req.query.id, formato: "JSON" });
      const r = await post("api.tiny.com.br", "/api2/contato.obter.php", params.toString(), { "Content-Type": "application/x-www-form-urlencoded" });
      const data = parseJSON(r.text);
      return res.status(200).json({ contato: (data.retorno && data.retorno.contato) ? data.retorno.contato : {} });
    }

    // GET /api/contatos?login=xxx&senha=yyy — autenticar usuário
    if (req.method === "GET" && req.query.login) {
      const usuario = await buscarUsuario(req.query.login, req.query.senha);
      if (!usuario) return res.status(401).json({ erro: "Usuário ou senha incorretos" });
      return res.status(200).json({ usuario });
    }

    return res.status(405).json({ erro: "Método não permitido" });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
