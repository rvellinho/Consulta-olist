const fetch = require("node-fetch");

const TOKEN = process.env.OLIST_TOKEN;
const API = "https://api.tiny.com.br/api2";
const PROXY = "https://corsproxy.io/?";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
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
      return res.status(200).json({ itens: lista });
    }

    if (req.method === "PUT") {
      const { id, nome, limiteCredito } = req.body;
      if (!id || limiteCredito === undefined) return res.status(400).json({ erro: "id e limiteCredito obrigatórios." });

      const xml = `<contatos><contato><id>${id}</id><nome>${nome}</nome><limite_credito>${limiteCredito}</limite_credito></contato></contatos>`;
      const params = new URLSearchParams({ token: TOKEN, contato: xml, formato: "JSON" });

      const apiRes = await fetch(`${API}/contato.alterar.php`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);
      const data = await apiRes.json();
      if (data.retorno?.status === "Erro") throw new Error(data.retorno?.erros?.[0]?.erro || "Erro ao salvar");
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
};
