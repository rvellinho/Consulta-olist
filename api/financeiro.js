// DRE + plano de contas + CRUD de lançamentos manuais.
// Dados já sincronizados por api/financeiro-sync-diario.js (financeiro_mensal,
// financeiro_categorias) — este endpoint só lê/agrega, nunca bate na Olist.
const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }
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
function supaHost() { return SUPABASE_URL.replace("https://", ""); }

// --- estrutura fixa do DRE (ver plano: "Plano de contas") ---
// sinal: como o bloco entra no resultado acumulado. subtotalNome: o rótulo do
// subtotal exibido IMEDIATAMENTE DEPOIS deste bloco (null = não fecha subtotal).
const ESTRUTURA_DRE = [
  { bloco: "Receita Bruta", linhas: ["receita_bruta"], sinal: 1, subtotalNome: null },
  { bloco: "Deduções da Receita Bruta", linhas: ["deducao_receita_bruta"], sinal: -1, subtotalNome: "Receita Líquida" },
  { bloco: "Custo da Mercadoria/Serviço Vendido", linhas: ["custo_mercadoria"], sinal: -1, subtotalNome: "Lucro Bruto" },
  {
    bloco: "Despesas Operacionais",
    linhas: ["despesa_marketing", "despesa_vendas_diretas", "custos_comerciais", "despesa_fretes",
      "despesa_infraestrutura", "despesa_pessoal", "despesa_estoque_armazenamento", "despesa_veiculos",
      "outras_despesas_operacao"],
    sinal: -1, subtotalNome: "Resultado Antes de Juros",
  },
  { bloco: "Despesas Financeiras (Juros)", linhas: ["despesa_endividamento"], sinal: -1, subtotalNome: "Lucro Líquido" },
  { bloco: "Distribuição de Lucro", linhas: ["distribuicao_lucro"], sinal: -1, subtotalNome: "Resultado do Período" },
];

async function buscarPlanoContas() {
  const r = await httpsRequest("GET", supaHost(),
    "/rest/v1/financeiro_plano_contas?select=codigo_grupo,descricao_grupo,linha_dre,ordem,regime,entra_dre,fonte_tiny&order=ordem.asc",
    null, supaHeaders);
  return parseJSON(r.text);
}

async function buscarMensal(empresas, ano, mes) {
  const filtroEmpresa = empresas.length === 1 ? `empresa=eq.${empresas[0]}` : `empresa=in.(${empresas.join(",")})`;
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_mensal?${filtroEmpresa}&ano=eq.${ano}&mes=eq.${mes}&select=codigo_grupo,categoria_id,origem,regime,valor,titulo_tipo,titulo_id`,
    null, supaHeaders);
  return parseJSON(r.text);
}

async function buscarManuais(empresas, ano, mes) {
  const filtroEmpresa = empresas.length === 1 ? `empresa=eq.${empresas[0]}` : `empresa=in.(${empresas.join(",")})`;
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_lancamentos_manuais?${filtroEmpresa}&ano=eq.${ano}&mes=eq.${mes}&select=*&order=codigo_grupo.asc`,
    null, supaHeaders);
  return parseJSON(r.text);
}

function montarDRE(planoContas, linhasMensal, linhasManuais) {
  const porGrupo = {};
  const naoClassificado = { total: 0, qtd: 0, itens: [] };

  for (const l of linhasMensal) {
    const valor = Number(l.valor) || 0;
    if (!l.codigo_grupo) {
      naoClassificado.total += valor;
      naoClassificado.qtd += 1;
      naoClassificado.itens.push({ categoria_id: l.categoria_id, origem: l.origem, titulo_tipo: l.titulo_tipo, titulo_id: l.titulo_id, valor });
      continue;
    }
    porGrupo[l.codigo_grupo] = (porGrupo[l.codigo_grupo] || 0) + valor;
  }
  for (const l of linhasManuais) {
    if (!l.codigo_grupo) continue;
    porGrupo[l.codigo_grupo] = (porGrupo[l.codigo_grupo] || 0) + (Number(l.valor) || 0);
  }

  const porLinhaDre = {};
  const gruposPorLinhaDre = {};
  for (const grupo of planoContas) {
    if (!grupo.entra_dre) continue;
    const valor = porGrupo[grupo.codigo_grupo] || 0;
    porLinhaDre[grupo.linha_dre] = (porLinhaDre[grupo.linha_dre] || 0) + valor;
    (gruposPorLinhaDre[grupo.linha_dre] = gruposPorLinhaDre[grupo.linha_dre] || []).push({
      codigo_grupo: grupo.codigo_grupo, descricao_grupo: grupo.descricao_grupo, valor,
    });
  }

  let acumulado = 0;
  const blocos = ESTRUTURA_DRE.map(def => {
    const grupos = def.linhas.flatMap(ld => gruposPorLinhaDre[ld] || []);
    const total = def.linhas.reduce((s, ld) => s + (porLinhaDre[ld] || 0), 0);
    acumulado += def.sinal * total;
    return { bloco: def.bloco, sinal: def.sinal, total, grupos, subtotalNome: def.subtotalNome, subtotalValor: def.subtotalNome ? acumulado : null };
  });

  return { blocos, resultadoFinal: acumulado, naoClassificado };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const acao = req.query.acao;

      if (acao === "dre") {
        const ano = parseInt(req.query.ano, 10);
        const mes = parseInt(req.query.mes, 10);
        if (!ano || !mes) return res.status(400).json({ erro: "ano e mes são obrigatórios" });
        const consolidado = req.query.consolidado === "true";
        const empresas = consolidado ? ["rampa", "tf"] : [String(req.query.empresa || "rampa").toLowerCase()];

        const [planoContas, linhasMensal, linhasManuais] = await Promise.all([
          buscarPlanoContas(),
          buscarMensal(empresas, ano, mes),
          buscarManuais(empresas, ano, mes),
        ]);
        const dre = montarDRE(planoContas, linhasMensal, linhasManuais);
        return res.status(200).json({ ano, mes, empresa: consolidado ? "consolidado" : empresas[0], ...dre });
      }

      if (acao === "plano-contas") {
        const empresa = String(req.query.empresa || "rampa").toLowerCase();
        const [planoContas, rCategorias] = await Promise.all([
          buscarPlanoContas(),
          httpsRequest("GET", supaHost(),
            `/rest/v1/financeiro_categorias?empresa=eq.${empresa}&select=categoria_id,grupo_raw,descricao_raw,codigo_grupo,codigo_leaf,forca_manual&order=codigo_grupo.asc`,
            null, supaHeaders),
        ]);
        return res.status(200).json({ planoContas, categorias: parseJSON(rCategorias.text) });
      }

      // Sem acao: listar lançamentos manuais (filtros opcionais empresa/ano/mes)
      const { empresa, ano, mes } = req.query;
      let path = "/rest/v1/financeiro_lancamentos_manuais?select=*&order=ano.desc,mes.desc,codigo_grupo.asc";
      if (empresa) path += "&empresa=eq." + encodeURIComponent(String(empresa).toLowerCase());
      if (ano) path += "&ano=eq." + encodeURIComponent(ano);
      if (mes) path += "&mes=eq." + encodeURIComponent(mes);
      const r = await httpsRequest("GET", supaHost(), path, null, supaHeaders);
      const data = parseJSON(r.text);
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    if (req.method === "POST") {
      const { empresa, ano, mes, codigo_grupo, categoria_id, subitem, valor, observacao, usuario } = parseBody(req.body);
      if (!empresa || !ano || !mes || !codigo_grupo || valor === undefined) {
        return res.status(400).json({ erro: "empresa, ano, mes, codigo_grupo e valor são obrigatórios" });
      }
      const payload = JSON.stringify({
        empresa: String(empresa).toLowerCase(),
        ano: parseInt(ano, 10),
        mes: parseInt(mes, 10),
        codigo_grupo,
        categoria_id: categoria_id || null,
        subitem: subitem || null,
        valor: Number(valor) || 0,
        observacao: observacao || null,
        usuario: usuario || null,
        atualizado_em: new Date().toISOString(),
      });
      const r = await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_lancamentos_manuais", payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=representation" });
      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      const data = parseJSON(r.text);
      return res.status(200).json(Array.isArray(data) ? data[0] : data);
    }

    if (req.method === "PUT") {
      const { id, codigo_grupo, categoria_id, subitem, valor, observacao, usuario } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });
      const updates = { atualizado_em: new Date().toISOString() };
      if (codigo_grupo !== undefined) updates.codigo_grupo = codigo_grupo;
      if (categoria_id !== undefined) updates.categoria_id = categoria_id || null;
      if (subitem !== undefined) updates.subitem = subitem || null;
      if (valor !== undefined) updates.valor = Number(valor) || 0;
      if (observacao !== undefined) updates.observacao = observacao || null;
      if (usuario !== undefined) updates.usuario = usuario || null;
      const payload = JSON.stringify(updates);
      const r = await httpsRequest("PATCH", supaHost(), "/rest/v1/financeiro_lancamentos_manuais?id=eq." + id, payload,
        { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const { id } = parseBody(req.body);
      if (!id) return res.status(400).json({ erro: "id obrigatório" });
      const r = await httpsRequest("DELETE", supaHost(), "/rest/v1/financeiro_lancamentos_manuais?id=eq." + id, null,
        { ...supaHeaders, Prefer: "return=minimal" });
      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido" });

  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
};
