// Gerenciamento de usuários via Supabase
const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d, headers: res.headers }));
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
    // GET — listar todos os usuários
    if (req.method === "GET") {
      const r = await httpsRequest("GET", supaHost,
        "/rest/v1/usuarios?select=id,login,perfil,ativo,criado_em&order=criado_em.asc",
        null,
        supaHeaders
      );
      const data = parseJSON(r.text);
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    // POST — criar usuário
    if (req.method === "POST") {
      const { login, senha, perfil } = parseBody(req.body);
      if (!login || !senha || !perfil) return res.status(400).json({ erro: "login, senha e perfil são obrigatórios" });

      const payload = JSON.stringify({ login: login.trim().toLowerCase(), senha, perfil, ativo: true });
      const r = await httpsRequest("POST", supaHost,
        "/rest/v1/usuarios",
        payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=representation" }
      );

      if (r.status >= 400) {
        const err = parseJSON(r.text);
        if (err.code === "23505") return res.status(400).json({ erro: "Login já existe." });
        return res.status(400).json({ erro: r.text });
      }
      return res.status(200).json({ ok: true });
    }

    // PUT — editar usuário
    if (req.method === "PUT") {
      const { id, login, senha, perfil, ativo } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });

      const updates = {};
      if (login) updates.login = login.trim().toLowerCase();
      if (senha) updates.senha = senha;
      if (perfil) updates.perfil = perfil;
      if (ativo !== undefined) updates.ativo = ativo;

      const payload = JSON.stringify(updates);
      const r = await httpsRequest("PATCH", supaHost,
        "/rest/v1/usuarios?id=eq." + id,
        payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" }
      );

      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
    }

    // DELETE — excluir usuário
    if (req.method === "DELETE") {
      const { id } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });

      const r = await httpsRequest("DELETE", supaHost,
        "/rest/v1/usuarios?id=eq." + id,
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
