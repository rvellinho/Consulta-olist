const fetch = require("node-fetch");

const TOKEN = process.env.OLIST_TOKEN;
const API = "https://api.tiny.com.br/api2";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function salvarAnalise(clienteId, dataAnalise, anotacoes, ultimoUsuario) {
  const payload = {
    cliente_id: String(clienteId),
    data_analise: dataAnalise || null,
    anotacoes: anotacoes || "",
    ultimo_usuario: ultimoUsuario,
    ultima_alteracao: new Date().toISOString(),
  };

  const resUpdate = await fetch(
    `${SUPABASE_URL}/rest/v1/analises_credito?cliente_id=eq.${clienteId}`,
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal,count=exact",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!resUpdate.ok) {
    const err = await resUpdate.text();
    throw new Error(`Supabase update erro: ${err}`);
  }

  const countHeader = resUpdate.headers.get("content-range");
  const naoAtualizou = !countHeader || countHeader === "*/0";

  if (naoAtualizou) {
    const resInsert = await fetch(`${SUPABASE_URL}/rest/v1/analises_credito`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });

    if (!resInsert.ok) {
      const err = await resInsert.text();
      throw new Error(`Supabase insert erro: ${err}`);
    }
  }

  return true;
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

    if (req.method === "GET" && req.query.id) {
      const params = new URLSearchParams({
        token: TOKEN,
        id: req.query.id,
        formato: "JSON",
      });

      const apiRes = await fetch(`${API}/contato.obter.php`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);
      const data = await apiRes.json();
      if (data.retorno?.status === "Erro") throw new Error(data.retorno?.erros?.[0]?.erro || "Erro API");

      const contato = data.retorno?.contato || {};
      return res.status(200).json({ contato });
    }

    if (req.method === "PUT") {
      const { id, nome, limiteCredito, dataAnalise, anotacoes, ultimoUsuario } = req.body;
      if (!id || limiteCredito === undefined) return res.status(400).json({ erro: "id e limiteCredito obrigatórios." });

      const limiteFormatado = parseFloat(limiteCredito).toFixed(2);

      // Atualiza limite no Olist
      const xml = `<contatos><contato><id>${id}</id><nome>${nome}</nome><limite_credito>${limiteFormatado}</limite_credito></contato></contatos>`;
      const params = new URLSearchParams({ token: TOKEN, contato: xml, formato: "JSON" });
      const apiRes = await fetch(`${API}/contato.alterar.php`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      // Captura resposta bruta para diagnóstico
      const textoOlist = await apiRes.text();

      // Tenta parsear mas não bloqueia se falhar
      let dataOlist = {};
      try { dataOlist = JSON.parse(textoOlist); } catch {}
      if (dataOlist.retorno?.status === "Erro") {
        throw new Error(dataOlist.retorno?.erros?.[0]?.erro || "Erro Olist");
      }

      // Salva análise no Supabase
      await salvarAnalise(id, dataAnalise, anotacoes, ultimoUsuario);

      return res.status(200).json({ ok: true, olistResposta: textoOlist });
    }

    return res.status(405).json({ erro: "Método não permitido." });

  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
