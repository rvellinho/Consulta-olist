// Correções manuais de vendedor/data de emissão para notas do Relatório de Vendas —
// necessário porque a Olist não permite alterar vendedor após a nota emitida, e
// notas de devolução/serviço às vezes vêm sem vendedor ou com vendedor errado.
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

// A Olist grava vendedor como "Rafael Vellinho" (só a primeira letra maiúscula).
// Normalizamos aqui pra "RAFAEL VELLINHO" ou "rafael vellinho" digitado na tela
// de Alterações caírem na mesma coluna do relatório, e não virarem vendedor novo.
function normalizarVendedor(nome) {
  if (!nome) return nome;
  return nome.trim().replace(/\s+/g, " ").toLowerCase()
    .replace(/(^|\s)(\S)/g, (m, sep, c) => sep + c.toUpperCase());
}

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

const TIPOS_VALIDOS = ["produto", "servico", "devolucao", "representacao", "aguia"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supaHost = SUPABASE_URL.replace("https://", "");

  try {
    // GET — listar todas as alterações
    if (req.method === "GET") {
      const r = await httpsRequest("GET", supaHost,
        "/rest/v1/alteracoes_relatorio?select=id,tipo_nota,numero_nota,vendedor,data_emissao,observacao,atualizado_em&order=atualizado_em.desc",
        null,
        supaHeaders
      );
      const data = parseJSON(r.text);
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    // POST — criar alteração
    if (req.method === "POST") {
      const { tipo_nota, numero_nota, vendedor, data_emissao, observacao } = parseBody(req.body);
      if (!TIPOS_VALIDOS.includes(tipo_nota)) return res.status(400).json({ erro: "tipo_nota inválido" });
      if (!numero_nota) return res.status(400).json({ erro: "numero_nota é obrigatório" });
      if (!vendedor && !data_emissao) return res.status(400).json({ erro: "informe vendedor ou data_emissao" });

      const payload = JSON.stringify({
        tipo_nota, numero_nota: String(numero_nota).trim(),
        vendedor: normalizarVendedor(vendedor) || null, data_emissao: data_emissao || null, observacao: observacao || null,
      });
      const r = await httpsRequest("POST", supaHost,
        "/rest/v1/alteracoes_relatorio",
        payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=representation" }
      );

      if (r.status >= 400) {
        const err = parseJSON(r.text);
        if (err.code === "23505") return res.status(400).json({ erro: "Já existe uma alteração pra essa nota. Edite a existente." });
        return res.status(400).json({ erro: r.text });
      }
      return res.status(200).json({ ok: true });
    }

    // PUT — editar alteração
    if (req.method === "PUT") {
      const { id, vendedor, data_emissao, observacao } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });

      const updates = { vendedor: normalizarVendedor(vendedor) || null, data_emissao: data_emissao || null, observacao: observacao || null, atualizado_em: new Date().toISOString() };
      const payload = JSON.stringify(updates);
      const r = await httpsRequest("PATCH", supaHost,
        "/rest/v1/alteracoes_relatorio?id=eq." + id,
        payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" }
      );

      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
    }

    // DELETE — excluir alteração
    if (req.method === "DELETE") {
      const { id } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });

      const r = await httpsRequest("DELETE", supaHost,
        "/rest/v1/alteracoes_relatorio?id=eq." + id,
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
