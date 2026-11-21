// DRE + plano de contas + CRUD de lançamentos manuais + sync diário.
// Fundido num arquivo só (antes: api/financeiro.js + api/financeiro-sync-diario.js)
// pra caber no limite de 12 Serverless Functions do plano Hobby da Vercel — ver
// CLAUDE.md "Vercel serverless — limitações". O sync diário roda agora via
// `?acao=sync-diario` (antes era o arquivo inteiro) — ver vercel.json (crons).
//
// Nota sobre o sync diário (GET /caixa): devolve 403 com a conexão OAuth atual
// — testado ao vivo, a lista de "roles" do token de acesso não inclui nenhuma
// de caixa/extrato. Por isso NÃO existe aqui uma fase "caixa" separada e barata
// (uma chamada por categoria) como foi pensado antes de testar. Em vez disso:
//   - Receita (grupos 1.xx) vem de contas-receber, pelo mês de EMISSÃO
//     (dataCompetencia nunca vem preenchida em contas a receber na prática —
//     confirmado ao vivo em várias notas pagas; emissão já é a competência de
//     uma venda, então nem precisa de janela alargada aqui).
//   - Imposto sobre venda (5.01) e despesas/CMV (2.xx/3.xx/4.xx) vêm de
//     contas-pagar, numa janela alargada por vencimento (±1 mês), com detalhe
//     por título decidindo o mês real: dataCompetencia pro imposto,
//     dataLiquidacao (data em que foi de fato pago) pra despesa.
const https = require("https");
const { getAccessToken } = require("./_lib/olist-auth");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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

// ============================================================================
// DRE + plano de contas + CRUD manual (antigo api/financeiro.js)
// ============================================================================

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

// ============================================================================
// Sync diário (antigo api/financeiro-sync-diario.js) — acionado via
// ?acao=sync-diario, nunca chamado pelo frontend (só pelo cron no vercel.json).
// ============================================================================

const ORCAMENTO_TOTAL_MS = 280000; // folga sob os 300s de maxDuration (vercel.json)
const MAX_TENTATIVAS_POR_TITULO = 3;
const SALVAR_PROGRESSO_A_CADA = 20;
// Mesmo raciocínio do estoque: precisa ser bem maior que o intervalo do cron
// diário (~24h), senão uma execução que precisa de vários dias pra terminar
// nunca termina (recomeça do zero todo dia antes de acabar).
const TRAVADO_APOS_MS = 36 * 60 * 60 * 1000;

function mesAlvoAnterior(ano, mes) {
  return mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
}
function formatarYYYYMM(ano, mes) { return `${ano}-${String(mes).padStart(2, "0")}`; }
function formatarData(ano, mes, dia) { return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`; }
function addMeses(ano, mes, delta) {
  const total = ano * 12 + (mes - 1) + delta;
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
}

// --- classificação por histórico (fallback pra título sem categoria na Tiny) ---
// Só cobre o grupo 5.01 (impostos sobre a venda) — caso real visto em
// 2026-11-20: categorias de imposto criadas na Tiny só nessa data, títulos
// pagos antes continuam com categoria=null. NUNCA usar isso pro grupo 5.02
// (impostos sobre o resultado) — esse é manual de propósito (ver plano).
const PADROES_HISTORICO_5_01 = [
  /\bPIS\b/i, /\bCOFINS\b/i, /\bICMS\b/i, /\bISSQN\b/i, /\bISS\b/i, /SIMPLES\s*NACIONAL/i,
];
function classificarPorHistorico(historico) {
  const texto = String(historico || "");
  return PADROES_HISTORICO_5_01.some(re => re.test(texto)) ? "5.01" : null;
}

// --- status / checkpoint (mesmo padrão de estoque_sync_status) ---

async function lerStatusSync(empresa) {
  const r = await httpsRequest("GET", supaHost(), `/rest/v1/financeiro_sync_status?empresa=eq.${empresa}&select=*`, null, supaHeaders);
  return parseJSON(r.text)?.[0] || null;
}
async function criarStatusSync(empresa) {
  const payload = JSON.stringify({ empresa });
  await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_sync_status?on_conflict=empresa", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=ignore-duplicates,return=minimal" });
}
async function salvarStatusSync(empresa, status) {
  const payload = JSON.stringify(status);
  await httpsRequest("PATCH", supaHost(), `/rest/v1/financeiro_sync_status?empresa=eq.${empresa}`, payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
}
// Grava ANTES de qualquer trabalho arriscado (e de novo no catch fatal) —
// mesmo motivo do estoque: sem isso uma falha bem no início não deixa
// rastro nenhum depois que o log da Vercel expira (ver CLAUDE.md).
async function marcarTentativaSync(empresa, erro) {
  await criarStatusSync(empresa);
  const campos = { ultima_tentativa_em: new Date().toISOString() };
  if (erro) campos.ultimo_erro = erro;
  const payload = JSON.stringify(campos);
  await httpsRequest("PATCH", supaHost(), `/rest/v1/financeiro_sync_status?empresa=eq.${empresa}`, payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
}

// --- plano de contas / categorias (lidos uma vez por execução) ---

async function lerPlanoContasSync() {
  const r = await httpsRequest("GET", supaHost(), "/rest/v1/financeiro_plano_contas?select=codigo_grupo,regime,fonte_tiny", null, supaHeaders);
  const linhas = parseJSON(r.text);
  const mapa = {};
  (Array.isArray(linhas) ? linhas : []).forEach(l => { mapa[l.codigo_grupo] = l; });
  return mapa;
}

async function lerCategoriasMapeadas(empresa) {
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_categorias?empresa=eq.${empresa}&select=categoria_id,codigo_grupo,forca_manual`, null, supaHeaders);
  const linhas = parseJSON(r.text);
  const mapa = {};
  (Array.isArray(linhas) ? linhas : []).forEach(l => { mapa[l.categoria_id] = l; });
  return mapa;
}

// --- categorias ---

async function syncCategorias(empresa, accessToken) {
  const limit = 100;
  let offset = 0;
  let total = 0;
  const linhas = [];
  while (true) {
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/categorias-receita-despesa?limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    const itens = data.itens || [];
    itens.forEach(it => {
      const grupoMatch = String(it.grupo || "").match(/^(\d+\.\d+)/);
      const leafMatch = String(it.descricao || "").match(/^(\d+\.\d+\.\d+)/);
      linhas.push({
        categoria_id: it.id,
        grupo_raw: it.grupo || null,
        descricao_raw: it.descricao || null,
        codigo_grupo: grupoMatch ? grupoMatch[1] : null,
        codigo_leaf: leafMatch ? leafMatch[1] : null,
        atualizado_em: new Date().toISOString(),
      });
    });
    total = data.paginacao?.total ?? itens.length;
    offset += limit;
    if (itens.length < limit || offset >= total) break;
    await sleep(600);
  }
  if (linhas.length) {
    const payload = JSON.stringify(linhas.map(l => ({ ...l, empresa })));
    // forca_manual NÃO entra no payload — upsert não toca nela, preserva o
    // que foi marcado à mão.
    await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_categorias?on_conflict=empresa,categoria_id", payload,
      { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=minimal" });
  }
  console.log(`[financeiro-sync:${empresa}] categorias: ${linhas.length} sincronizadas`);
  return linhas.length;
}

// --- upsert na agregação mensal ---

async function upsertMensal(empresa, linhas) {
  if (!linhas.length) return;
  const payload = JSON.stringify(linhas.map(l => ({ ...l, empresa, atualizado_em: new Date().toISOString() })));
  await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_mensal?on_conflict=empresa,titulo_tipo,titulo_id", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=minimal" });
}

// --- receita (contas-receber, por emissão = competência de uma venda) ---

async function listarIdsContasReceber(accessToken, dataIni, dataFim) {
  const ids = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/contas-receber?dataInicialEmissao=${dataIni}&dataFinalEmissao=${dataFim}&limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    const itens = data.itens || [];
    itens.forEach(it => ids.push(it.id));
    const total = data.paginacao?.total ?? itens.length;
    offset += limit;
    if (itens.length < limit || offset >= total) break;
    await sleep(600);
  }
  return ids;
}

// --- contas a pagar (imposto sobre venda por competência + despesas por caixa, numa janela larga por vencimento) ---

async function listarIdsContasPagar(accessToken, dataIni, dataFim) {
  const ids = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", "api.tiny.com.br",
      `/public-api/v3/contas-pagar?dataInicialVencimento=${dataIni}&dataFinalVencimento=${dataFim}&limit=${limit}&offset=${offset}`,
      null, { Authorization: "Bearer " + accessToken });
    const data = parseJSON(r.text);
    const itens = Array.isArray(data) ? data : (data.itens || []);
    itens.forEach(it => ids.push(it.id));
    const total = data.paginacao?.total ?? itens.length;
    offset += limit;
    if (itens.length < limit || offset >= total) break;
    await sleep(600);
  }
  return ids;
}

async function executarSyncDiario(req, res) {
  const empresa = String(req.query.empresa || "rampa").toLowerCase();

  // GET só lê o status (usado por um eventual botão "sincronizar agora" no
  // frontend, igual ao de Estoque) — não dispara processamento.
  if (req.method === "GET") {
    try {
      const status = await lerStatusSync(empresa);
      return res.status(200).json({ ok: true, status });
    } catch (e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  const vercelCron = req.headers["x-vercel-cron"];
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}` && !vercelCron) {
    return res.status(401).json({ erro: "não autorizado" });
  }

  const inicioExecucao = Date.now();

  try {
    let status = await lerStatusSync(empresa);
    const ultimaAtividade = status?.ultima_tentativa_em || status?.iniciado_em;
    const iniciadoHaMuito = status?.em_andamento && ultimaAtividade
      && (Date.now() - new Date(ultimaAtividade).getTime() > TRAVADO_APOS_MS);
    await marcarTentativaSync(empresa);

    const accessToken = await getAccessToken(empresa);
    const planoContas = await lerPlanoContasSync();

    // Categorias são rápidas (uma lista paginada só) — sempre atualiza antes
    // de montar a fila, pra qualquer categoria nova já entrar classificada.
    await syncCategorias(empresa, accessToken);
    const categorias = await lerCategoriasMapeadas(empresa);

    const hoje = new Date();
    const mesAtual = { ano: hoje.getFullYear(), mes: hoje.getMonth() + 1 };
    const mesAnterior = mesAlvoAnterior(mesAtual.ano, mesAtual.mes);
    const periodos = [mesAtual, mesAnterior]; // reprocessa os 2 últimos meses, não assume mês fechado como imutável

    if (!status || !status.em_andamento || iniciadoHaMuito) {
      const filaReceita = [];
      const filaPagar = [];
      for (const p of periodos) {
        const iniEmissao = formatarData(p.ano, p.mes, 1);
        const fimEmissao = formatarData(p.ano, p.mes, 28);
        const idsReceber = await listarIdsContasReceber(accessToken, iniEmissao, fimEmissao);
        idsReceber.forEach(id => filaReceita.push({ id, ano: p.ano, mes: p.mes }));
        await sleep(600);

        // Janela larga por vencimento (mês alvo ±1) pra pegar título cuja
        // competência/liquidação real cai no mês alvo mesmo com vencimento
        // num mês vizinho.
        const jIni = addMeses(p.ano, p.mes, -1);
        const jFim = addMeses(p.ano, p.mes, 1);
        const idsPagar = await listarIdsContasPagar(accessToken, formatarData(jIni.ano, jIni.mes, 1), formatarData(jFim.ano, jFim.mes, 28));
        idsPagar.forEach(id => filaPagar.push({ id, ano: p.ano, mes: p.mes }));
        await sleep(600);
      }
      // Dedup simples por id+ano+mes (a janela de meses vizinhos pode repetir título em dois períodos-alvo)
      const vistoPagar = new Set();
      const filaPagarUnica = filaPagar.filter(it => {
        const chave = `${it.id}:${it.ano}:${it.mes}`;
        if (vistoPagar.has(chave)) return false;
        vistoPagar.add(chave); return true;
      });

      status = {
        em_andamento: true,
        pendentes: { receita: filaReceita, pagar: filaPagarUnica },
        total: filaReceita.length + filaPagarUnica.length,
        processados: 0,
        iniciado_em: new Date().toISOString(),
        concluido_em: null,
        ultimo_erro: null,
      };
      await salvarStatusSync(empresa, status);
      console.log(`[financeiro-sync:${empresa}] execução nova: ${filaReceita.length} contas a receber + ${filaPagarUnica.length} contas a pagar a classificar`);
    } else {
      console.log(`[financeiro-sync:${empresa}] retomando: ${status.pendentes.receita.length} receber + ${status.pendentes.pagar.length} pagar pendentes`);
    }

    const filaReceita = [...status.pendentes.receita];
    const filaPagar = [...status.pendentes.pagar];
    // Granularidade por título (não por categoria somada): cada upsert é
    // idempotente, então um checkpoint no meio do caminho nunca sobrescreve
    // parte do total já gravado por um checkpoint anterior — a soma por
    // categoria/mês é feita por quem lê (acao=dre), nunca aqui.
    let lote = [];
    let processadosDesdeCheckpoint = 0;

    async function salvarLote() {
      if (lote.length) await upsertMensal(empresa, lote);
      lote = [];
    }

    while (filaReceita.length > 0 && (Date.now() - inicioExecucao) < ORCAMENTO_TOTAL_MS) {
      const item = filaReceita.shift();
      await sleep(600);
      try {
        const rd = await httpsRequest("GET", "api.tiny.com.br", `/public-api/v3/contas-receber/${item.id}`, null, { Authorization: "Bearer " + accessToken });
        const d = parseJSON(rd.text);
        const catId = d.categoria?.id;
        const cat = catId != null ? categorias[catId] : null;
        if (!(cat && cat.forca_manual)) {
          const codigoGrupo = cat?.codigo_grupo || null;
          const linha = codigoGrupo ? planoContas[codigoGrupo] : null;
          if (!linha || linha.fonte_tiny === "contas_receber") {
            lote.push({
              ano: item.ano, mes: item.mes, codigo_grupo: codigoGrupo, categoria_id: catId ?? null,
              origem: "tiny_competencia", regime: "competencia",
              titulo_tipo: "receber", titulo_id: item.id, valor: Number(d.valor) || 0,
            });
          }
        }
      } catch (erroRede) {
        console.error(`[financeiro-sync] erro no título contas-receber ${item.id}: ${erroRede.message}`);
        item.tentativas = (item.tentativas || 0) + 1;
        if (item.tentativas <= MAX_TENTATIVAS_POR_TITULO) filaReceita.push(item);
      }
      processadosDesdeCheckpoint++;
      if (processadosDesdeCheckpoint >= SALVAR_PROGRESSO_A_CADA) {
        await salvarLote();
        status.pendentes.receita = filaReceita;
        status.processados = status.total - filaReceita.length - filaPagar.length;
        await salvarStatusSync(empresa, status);
        console.log(`[financeiro-sync:${empresa}] checkpoint (receita): ${status.processados}/${status.total}`);
        processadosDesdeCheckpoint = 0;
      }
    }

    while (filaPagar.length > 0 && (Date.now() - inicioExecucao) < ORCAMENTO_TOTAL_MS) {
      const item = filaPagar.shift();
      await sleep(600);
      try {
        const rd = await httpsRequest("GET", "api.tiny.com.br", `/public-api/v3/contas-pagar/${item.id}`, null, { Authorization: "Bearer " + accessToken });
        const d = parseJSON(rd.text);
        const catId = d.categoria?.id;
        const cat = catId != null ? categorias[catId] : null;
        if (!(cat && cat.forca_manual)) {
          let codigoGrupo = cat?.codigo_grupo || null;
          let viaHistorico = false;
          if (!codigoGrupo) {
            // Categoria não existia na Tiny no momento do lançamento (ex: as
            // categorias de imposto 5.01 só foram criadas em 2026-11-20 —
            // títulos pagos antes disso ficam com categoria=null pra sempre,
            // a menos que alguém volte e retagueie manualmente na Tiny).
            // Enquanto isso não acontece, usamos o texto do histórico como
            // pista — ver "Classificação por histórico" no plano.
            const grupoHeuristico = classificarPorHistorico(d.historico);
            if (grupoHeuristico) { codigoGrupo = grupoHeuristico; viaHistorico = true; }
          }
          const linha = codigoGrupo ? planoContas[codigoGrupo] : null;

          if (linha && linha.regime === "competencia" && linha.fonte_tiny === "contas_pagar") {
            // Imposto sobre venda (5.01): conta no mês da dataCompetencia real, não do vencimento usado pra listar.
            if (d.dataCompetencia === formatarYYYYMM(item.ano, item.mes)) {
              lote.push({
                ano: item.ano, mes: item.mes, codigo_grupo: codigoGrupo, categoria_id: viaHistorico ? null : catId,
                origem: viaHistorico ? "tiny_historico" : "tiny_competencia", regime: "competencia",
                titulo_tipo: "pagar", titulo_id: item.id, valor: Number(d.valor) || 0,
              });
            }
          } else if ((!linha || linha.regime === "caixa") && (d.situacao === "pago" || d.situacao === "parcial")) {
            // Despesa/CMV por caixa: conta no mês em que foi de fato liquidado.
            // Categoria não mapeada (linha=null) também cai aqui, como "não
            // classificado" (codigo_grupo=null), em vez de ser descartada.
            const dataLiq = String(d.dataLiquidacao || "").slice(0, 7); // "YYYY-MM"
            if (dataLiq === formatarYYYYMM(item.ano, item.mes)) {
              const valor = Number(d.valorPago) || Number(d.valor) || 0;
              lote.push({
                ano: item.ano, mes: item.mes, codigo_grupo: codigoGrupo, categoria_id: catId ?? null,
                origem: "tiny_caixa", regime: "caixa",
                titulo_tipo: "pagar", titulo_id: item.id, valor,
              });
            }
          }
        }
      } catch (erroRede) {
        console.error(`[financeiro-sync] erro no título contas-pagar ${item.id}: ${erroRede.message}`);
        item.tentativas = (item.tentativas || 0) + 1;
        if (item.tentativas <= MAX_TENTATIVAS_POR_TITULO) filaPagar.push(item);
      }
      processadosDesdeCheckpoint++;
      if (processadosDesdeCheckpoint >= SALVAR_PROGRESSO_A_CADA) {
        await salvarLote();
        status.pendentes.pagar = filaPagar;
        status.processados = status.total - filaReceita.length - filaPagar.length;
        await salvarStatusSync(empresa, status);
        console.log(`[financeiro-sync:${empresa}] checkpoint (pagar): ${status.processados}/${status.total}`);
        processadosDesdeCheckpoint = 0;
      }
    }

    await salvarLote();
    status.pendentes = { receita: filaReceita, pagar: filaPagar };
    status.processados = status.total - filaReceita.length - filaPagar.length;

    if (filaReceita.length === 0 && filaPagar.length === 0) {
      status.em_andamento = false;
      status.concluido_em = new Date().toISOString();
      await salvarStatusSync(empresa, status);
      console.log(`[financeiro-sync:${empresa}] concluído: ${status.total} títulos classificados em ${Math.round((Date.now() - inicioExecucao) / 1000)}s`);
      return res.status(200).json({ ok: true, concluido: true, total: status.total });
    }

    await salvarStatusSync(empresa, status);
    console.error(`[financeiro-sync:${empresa}] orçamento de tempo esgotado: ${status.processados}/${status.total} — precisa de outra chamada pra terminar`);
    return res.status(200).json({ ok: true, concluido: false, processados: status.processados, restante: filaReceita.length + filaPagar.length });

  } catch (e) {
    console.error(`[financeiro-sync:${empresa}] erro fatal:`, e.message);
    try { await marcarTentativaSync(empresa, e.message); } catch (_) { /* best-effort */ }
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
}

// ============================================================================
// Handler principal
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Sync diário (cron) — nunca chamado pelo frontend, ver vercel.json.
  if (req.query.acao === "sync-diario") {
    return executarSyncDiario(req, res);
  }

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
