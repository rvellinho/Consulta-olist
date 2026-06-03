const fetch = require("node-fetch");
const { getAccessToken } = require("./token");

const API_BASE = "https://api.tiny.com.br/public-api/v3";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const token = await getAccessToken();

    if (req.method === "GET") {
      const pagina = req.query.pagina || 1;
      const pesquisa = req.query.pesquisa || "";

      const params = new URLSearchParams({
        situacao: "A",
        limit: 100,
        offset: (pagina - 1) * 100,
      });

      if (pesquisa) params.append("nome", pesquisa);

      const apiRes = await fetch(`${API_BASE}/contatos?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!apiRes.ok) {
        const err = await apiRes.text();
        return res.status(apiRes.status).json({ erro: err });
      }

      const data = await apiRes.json();
      return res.status(200).json(data);
    }

    if (req.method === "PUT") {
      const { id, limiteCredito, nome } = req.body;

      if (!id || limiteCredito === undefined) {
        return res.status(400).json({ erro: "id e limiteCredito são obrigatórios." });
      }

      const apiRes = await fetch(`${API_BASE}/contatos/${id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nome: nome,
          dadosAdicionais: {
            limiteCredito: parseFloat(limiteCredito),
          },
        }),
      });

      if (!apiRes.ok) {
        const err = await apiRes.text();
        return res.status(apiRes.status).json({ erro: err });
      }

      const text = await apiRes.text();
      const data = text ? JSON.parse(text) : { ok: true };
      return res.status(200).json(data);
    }

    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error("Erro interno:", e.message);
    return res.status(500).json({ erro: e.message });
  }
};
