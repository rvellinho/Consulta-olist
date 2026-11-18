// CRUD de lançamentos manuais de Contatos/Propostas por Ano+Mês+Carteira, via Supabase
const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
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

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supaHost = SUPABASE_URL.replace("https://", "");

  try {
    // GET — listar lançamentos, opcionalmente filtrando por ano
    if (req.method === "GET") {
      const { ano } = req.query || {};
      let path = "/rest/v1/contatos_propostas?select=*&order=ano.desc,mes.desc,carteira.asc";
      if (ano) path += "&ano=eq." + encodeURIComponent(ano);

      const r = await httpsRequest("GET", supaHost, path, null, supaHeaders);
      const data = parseJSON(r.text);
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    // POST — criar lançamento
    if (req.method === "POST") {
      const { ano, mes, carteira, contatos, propostas, usuario } = parseBody(req.body);
      if (!ano || !mes || !carteira) return res.status(400).json({ erro: "ano, mes e carteira são obrigatórios" });

      const payload = JSON.stringify({
        ano: parseInt(ano, 10),
        mes: parseInt(mes, 10),
        carteira,
        contatos: parseInt(contatos, 10) || 0,
        propostas: parseInt(propostas, 10) || 0,
        atualizado_por: usuario || null,
        atualizado_em: new Date().toISOString(),
      });

      const r = await httpsRequest("POST", supaHost,
        "/rest/v1/contatos_propostas",
        payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=representation" }
      );

      if (r.status >= 400) {
        const err = parseJSON(r.text);
        if (err.code === "23505") return res.status(400).json({ erro: "Já existe um lançamento para essa Carteira nesse Ano/Mês." });
        return res.status(400).json({ erro: r.text });
      }
      const data = parseJSON(r.text);
      return res.status(200).json(Array.isArray(data) ? data[0] : data);
    }

    // PUT — editar lançamento existente
    if (req.method === "PUT") {
      const { id, ano, mes, carteira, contatos, propostas, usuario } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });

      const updates = {
        atualizado_por: usuario || null,
        atualizado_em: new Date().toISOString(),
      };
      if (ano !== undefined) updates.ano = parseInt(ano, 10);
      if (mes !== undefined) updates.mes = parseInt(mes, 10);
      if (carteira !== undefined) updates.carteira = carteira;
      if (contatos !== undefined) updates.contatos = parseInt(contatos, 10) || 0;
      if (propostas !== undefined) updates.propostas = parseInt(propostas, 10) || 0;

      const payload = JSON.stringify(updates);
      const r = await httpsRequest("PATCH", supaHost,
        "/rest/v1/contatos_propostas?id=eq." + id,
        payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" }
      );

      if (r.status >= 400) {
        const err = parseJSON(r.text);
        if (err.code === "23505") return res.status(400).json({ erro: "Já existe um lançamento para essa Carteira nesse Ano/Mês." });
        return res.status(400).json({ erro: r.text });
      }
      return res.status(200).json({ ok: true });
    }

    // DELETE — excluir lançamento
    if (req.method === "DELETE") {
      const { id } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });

      const r = await httpsRequest("DELETE", supaHost,
        "/rest/v1/contatos_propostas?id=eq." + id,
        null,
        { ...supaHeaders, Prefer: "return=minimal" }
      );

      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido" });

  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
};
