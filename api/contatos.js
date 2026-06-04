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

  // Primeiro tenta atualizar (UPDATE)
  const resUpdate = await fetch(
    `${SUPABASE_URL}/rest/v1/analises_credito?cliente_id=eq.${clienteId}`,
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!resUpdate.ok) {
    const err = await resUpdate.text();
    throw new Error(`Supabase update erro: ${err}`);
  }

  // Verifica se atualizou algum registro
  const countHeader = resUpdate.headers.get("content-range");
  const atualizou = countHeader && !countHeader.startsWith("*/0") && countHeader !== "*/*";

  // Se não existia registro, insere (INSERT)
  if (!atualizou) {
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
    // ── GET /api/contatos?pagina=1&pesquisa=xxx ───────────────────────────
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
