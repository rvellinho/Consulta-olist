const axios = require("axios");

const TOKEN = process.env.OLIST_TOKEN;
const API = "https://api.tiny.com.br/api2";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function salvarAnalise(clienteId, dataAnalise, anotacoes, ultimoUsuario) {
  const payload = {
    cliente_id: String(clienteId),
    data_analise: dataAnalise || null,
    anotacoes: anotacoes || "",
    ultimo_usuario: ultimoUsuario,
    ultima_alteracao: new Date().toISOString(),
  };

  const resUpdate = await axios.patch(
    `${SUPABASE_URL}/rest/v1/analises_credito?cliente_id=eq.${clienteId}`,
    payload,
    { headers: { ...supabaseHeaders, Prefer: "return=minimal,count=exact" } }
  );

  const countHeader = resUpdate.headers["content-range"];
  const naoAtualizou = !countHeader || countHeader === "*/0";

  if (naoAtualizou) {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/analises_credito`,
      payload,
      { headers: { ...supabaseHeaders, Prefer: "return=minimal" } }
    );
  }

  return true;
}

// Parser manual do body para Vercel
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    // Vercel já parseia o body automaticamente
    if (req.body && typeof req.body === "object") return resolve(req.body);
    // Fallback para leitura manual
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ── GET lista de clientes ─────────────────────────────────────────────
    if (req.method === "GET" && !req.query.id) {
      const pagina = req.query.pagina || 1;
      const pesquisa = req.query.pesquisa || " ";

      const params = new URLSearchParams({
        token: TOKEN,
        pesquisa,
        situacao: "A",
        pagina: String(pagina),
        formato: "JSON",
      });

      const { data } = await axios.post(
        `${API}/contatos.pesquisa.php`,
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      if (data.retorno?.status === "Erro") throw new Error(data.retorno?.erros?.[0]?.erro || "Erro API");

      const lista = data.retorno?.contatos?.map(c => c.contato) || [];
      const ids = lista.map(c => c.id);
      let analises = {};

      if (ids.length > 0) {
        const { data: anData } = await axios.get(
          `${SUPABASE_URL}/rest/v1/analises_credito?cliente_id=in.(${ids.join(",")})`,
          { headers: supabaseHeaders }
        );
        if (Array.isArray(anData)) {
          anData.forEach(a => { analises[a.cliente_id] = a; });
        }
      }

      return res.status(200).json({ itens: lista, analises });
    }

    // ── GET cliente individual (com limite) ───────────────────────────────
    if (req.method === "GET" && req.query.id) {
      const params = new URLSearchParams({
        token: TOKEN,
        id: req.query.id,
        formato: "JSON",
      });

      const { data } = await axios.post(
        `${API}/contato.obter.php`,
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      if (data.retorno?.status === "Erro") throw new Error(data.retorno?.erros?.[0]?.erro || "Erro API");

      return res.status(200).json({ contato: data.retorno?.contato || {} });
    }

    // ── PUT salvar limite + análise ───────────────────────────────────────
    if (req.method === "PUT") {
      const body = await parseBody(req);
      const { id, nome, limiteCredito, dataAnalise, anotacoes, ultimoUsuario } = body;

      if (!id || limiteCredito === undefined) return res.status(400).json({ erro: "id e limiteCredito obrigatórios." });

      const limiteFormatado = parseFloat(limiteCredito).toFixed(2);
      const xml = `<contatos><contato><id>${id}</id><nome>${nome}</nome><limite_credito>${limiteFormatado}</limite_credito></contato></contatos>`;
      const params = new URLSearchParams({ token: TOKEN, contato: xml, formato: "JSON" });

      const { data: dataOlist } = await axios.post(
        `${API}/contato.alterar.php`,
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      if (dataOlist.retorno?.status === "Erro") {
        throw new Error(dataOlist.retorno?.erros?.[0]?.erro || "Erro Olist");
      }

      await salvarAnalise(id, dataAnalise, anotacoes, ultimoUsuario);

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido." });

  } catch (e) {
    return res.status(500).json({
      erro: e.message,
      detalhe: e.response?.data || null,
      stack: e.stack,
    });
  }
};
