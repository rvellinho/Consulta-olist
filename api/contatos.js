const https = require("https");
const http = require("http");

const TOKEN = process.env.OLIST_TOKEN;
const API_HOST = "api.tiny.com.br";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: options.headers || {},
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function olistPost(endpoint, params) {
  const res = await request(
    `https://${API_HOST}/api2/${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
    params.toString()
  );
  try { return JSON.parse(res.text); } catch { return {}; }
}

async function supabaseGet(path) {
  const res = await request(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  try { return JSON.parse(res.text); } catch { return []; }
}

async function supabasePatch(path, payload) {
  const body = JSON.stringify(payload);
  const res = await request(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Prefer: "return=minimal,count=exact",
      },
    },
    body
  );
  return res;
}

async function supabasePost(path, payload) {
  const body = JSON.stringify(payload);
  const res = await request(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Prefer: "return=minimal",
      },
    },
    body
  );
  return res;
}

async function salvarAnalise(clienteId, dataAnalise, anotacoes, ultimoUsuario) {
  const payload = {
    cliente_id: String(clienteId),
    data_analise: dataAnalise || null,
    anotacoes: anotacoes || "",
    ultimo_usuario: ultimoUsuario,
    ultima_alteracao: new Date().toISOString(),
  };

  const resUpdate = await supabasePatch(
    `analises_credito?cliente_id=eq.${clienteId}`,
    payload
  );

  const countHeader = resUpdate.headers["content-range"];
  const naoAtualizou = !countHeader || countHeader === "*/0";

  if (naoAtualizou) {
    await supabasePost("analises_credito", payload);
  }

  return true;
}

async function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
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

      const data = await olistPost("contatos.pesquisa.php", params);
      if (data.retorno?.status === "Erro") throw new Error(data.retorno?.erros?.[0]?.erro || "Erro API");

      const lista = data.retorno?.contatos?.map(c => c.contato) || [];
      const ids = lista.map(c => c.id);
      let analises = {};

      if (ids.length > 0) {
        const anData = await supabaseGet(`analises_credito?cliente_id=in.(${ids.join(",")})`);
        if (Array.isArray(anData)) {
          anData.forEach(a => { analises[a.cliente_id] = a; });
        }
      }

      return res.status(200).json({ itens: lista, analises });
    }

    // ── GET individual ────────────────────────────────────────────────────
    if (req.method === "GET" && req.query.id) {
      const params = new URLSearchParams({ token: TOKEN, id: req.query.id, formato: "JSON" });
      const data = await olistPost("contato.obter.php", params);
      if (data.retorno?.status === "Erro") throw new Error(data.retorno?.erros?.[0]?.erro || "Erro API");
      return res.status(200).json({ contato: data.retorno?.contato || {} });
    }

    // ── PUT salvar ────────────────────────────────────────────────────────
    if (req.method === "PUT") {
      const body = await parseBody(req);
      const { id, nome, limiteCredito, dataAnalise, anotacoes, ultimoUsuario } = body;

      if (!id || limiteCredito === undefined) return res.status(400).json({ erro: "id e limiteCredito obrigatórios." });

      const limiteFormatado = parseFloat(limiteCredito).toFixed(2);
      const xml = `<contatos><contato><id>${id}</id><nome>${nome}</nome><limite_credito>${limiteFormatado}</limite_credito></contato></contatos>`;
      const params = new URLSearchParams({ token: TOKEN, contato: xml, formato: "JSON" });

      const dataOlist = await olistPost("contato.alterar.php", params);
      if (dataOlist.retorno?.status === "Erro") {
        throw new Error(dataOlist.retorno?.erros?.[0]?.erro || "Erro Olist");
      }

      await salvarAnalise(id, dataAnalise, anotacoes, ultimoUsuario);

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido." });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
