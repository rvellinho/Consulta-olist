const fetch = require("node-fetch");

const TOKEN = process.env.OLIST_TOKEN;
const API = "https://api.tiny.com.br/api2";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function lerAnalise(clienteId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/analises_credito?cliente_id=eq.${clienteId}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  const data = await res.json();
  return data[0] || null;
}

async function salvarAnalise(clienteId, dataAnalise, anotacoes, ultimoUsuario) {
  const payload = {
    cliente_id: String(clienteId),
    data_analise: dataAnalise || null,
    anotacoes: anotacoes || "",
    ultimo_usuario: ultimoUsuario,
    ultima_alteracao: new Date().toISOString(),
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/analises_credito`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase erro: ${err}`);
  }
  return true;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ── GET — listar clientes ─────────────────────────────────────────────
    if (req.method === "GET") {
      const pagina = req.query.pagina || 1;
      const pesquisa = req.query.pesquisa || " ";

      const params = new URLSearchParams({
        token: TOKEN,
        pesquisa: pesquisa,
        situacao: "A",
        pagina: String(pagina),
        formato: "JSON",
      });

      const apiRes = await fetch(`${API}/contatos.pesquisa.php`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);
      const data = await apiRes.json();
      if (data.retorno?.status === "Erro") throw new Error(data.retorno?.erros?.[0]?.erro || "Erro API");

      const lista = data.retorno?.contatos?.map(c => c.contato) || [];

      // Busca análises salvas para os clientes desta página
      const ids = lista.map(c => c.id);
      let analises = {};
      if (ids.length > 0) {
        const anRes = await fetch(
          `${SUPABASE_URL}/rest/v1/analises_credito?cliente_id=in.(${ids.join(",")})`,
          {
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
            },
          }
        );
        const anData = await anRes.json();
        if (Array.isArray(anData)) {
          anData.forEach(a => { analises[a.cliente_id] = a; });
        }
      }

      return res.status(200).json({ itens: lista, analises });
    }

    // ── PUT — salvar limite + análise ─────────────────────────────────────
    if (req.method === "PUT") {
      const { id, nome, limiteCredito, dataAnalise, anotacoes, ultimoUsuario } = req.body;
      if (!id || limiteCredito === undefined) return res.status(400).json({ erro: "id e limiteCredito obrigatórios." });

      // Atualiza limite no Olist
      const xml = `<contatos><contato><id>${id}</id><nome>${nome}</nome><limite_credito>${limiteCredito}</limite_credito></contato></contatos>`;
      const params = new URLSearchParams({ token: TOKEN, contato: xml, formato: "JSON" });

      const apiRes = await fetch(`${API}/contato.alterar.php`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);

      // Lê resposta como texto para evitar erro de JSON inválido
      const texto = await apiRes.text();
      let data = {};
      try { data = JSON.parse(texto); } catch {}
      if (data.retorno?.status === "Erro") throw new Error(data.retorno?.erros?.[0]?.erro || "Erro ao salvar");

      // Salva análise no Supabase
      await salvarAnalise(id, dataAnalise, anotacoes, ultimoUsuario);

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
};
