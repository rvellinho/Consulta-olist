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
const { getConfigEmpresa } = require("./_lib/empresas");

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
    `/rest/v1/financeiro_mensal?${filtroEmpresa}&ano=eq.${ano}&mes=eq.${mes}&select=codigo_grupo,categoria_id,origem,regime,valor,titulo_tipo,titulo_id,intercompany`,
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

// Cada grupo/linha/bloco guarda {operacional, intercompany} em vez de um valor
// só — ver CLAUDE.md "Intercompany Rampa↔TF". `valor`/`total`/`resultadoFinal`
// continuam somando os dois (operacional + intercompany), sem mudar o que já
// existia; os campos novos (*Operacional/*Intercompany) são só a abertura.
function montarDRE(planoContas, linhasMensal, linhasManuais) {
  const porGrupo = {}; // { [codigo_grupo]: {operacional, intercompany} }
  const naoClassificado = { total: 0, qtd: 0, itens: [] };

  function somar(grupo, valor, intercompany) {
    if (!porGrupo[grupo]) porGrupo[grupo] = { operacional: 0, intercompany: 0 };
    if (intercompany) porGrupo[grupo].intercompany += valor;
    else porGrupo[grupo].operacional += valor;
  }

  for (const l of linhasMensal) {
    const valor = Number(l.valor) || 0;
    if (!l.codigo_grupo) {
      naoClassificado.total += valor;
      naoClassificado.qtd += 1;
      naoClassificado.itens.push({ categoria_id: l.categoria_id, origem: l.origem, titulo_tipo: l.titulo_tipo, titulo_id: l.titulo_id, valor, intercompany: !!l.intercompany });
      continue;
    }
    somar(l.codigo_grupo, valor, !!l.intercompany);
  }
  for (const l of linhasManuais) {
    if (!l.codigo_grupo) continue;
    // Lançamentos manuais (provisões/ajustes) nunca são intercompany — esse
    // esquema só existe pra lançamentos que vêm da Olist (nota de venda da
    // Rampa pra TF, ou despesa marcada manualmente num título real).
    somar(l.codigo_grupo, Number(l.valor) || 0, false);
  }

  const porLinhaDre = {}; // { [linha_dre]: {operacional, intercompany} }
  const gruposPorLinhaDre = {};
  for (const grupo of planoContas) {
    if (!grupo.entra_dre) continue;
    const valores = porGrupo[grupo.codigo_grupo] || { operacional: 0, intercompany: 0 };
    if (!porLinhaDre[grupo.linha_dre]) porLinhaDre[grupo.linha_dre] = { operacional: 0, intercompany: 0 };
    porLinhaDre[grupo.linha_dre].operacional += valores.operacional;
    porLinhaDre[grupo.linha_dre].intercompany += valores.intercompany;
    (gruposPorLinhaDre[grupo.linha_dre] = gruposPorLinhaDre[grupo.linha_dre] || []).push({
      codigo_grupo: grupo.codigo_grupo, descricao_grupo: grupo.descricao_grupo,
      valor: valores.operacional + valores.intercompany,
      valorOperacional: valores.operacional, valorIntercompany: valores.intercompany,
    });
  }

  let acumulado = 0, acumuladoOperacional = 0, acumuladoIntercompany = 0;
  const blocos = ESTRUTURA_DRE.map(def => {
    const grupos = def.linhas.flatMap(ld => gruposPorLinhaDre[ld] || []);
    const totalOperacional = def.linhas.reduce((s, ld) => s + (porLinhaDre[ld]?.operacional || 0), 0);
    const totalIntercompany = def.linhas.reduce((s, ld) => s + (porLinhaDre[ld]?.intercompany || 0), 0);
    const total = totalOperacional + totalIntercompany;
    acumulado += def.sinal * total;
    acumuladoOperacional += def.sinal * totalOperacional;
    acumuladoIntercompany += def.sinal * totalIntercompany;
    return {
      bloco: def.bloco, sinal: def.sinal, total, totalOperacional, totalIntercompany, grupos,
      subtotalNome: def.subtotalNome,
      subtotalValor: def.subtotalNome ? acumulado : null,
      subtotalOperacional: def.subtotalNome ? acumuladoOperacional : null,
      subtotalIntercompany: def.subtotalNome ? acumuladoIntercompany : null,
    };
  });

  return {
    blocos, resultadoFinal: acumulado,
    resultadoFinalOperacional: acumuladoOperacional, resultadoFinalIntercompany: acumuladoIntercompany,
    naoClassificado,
  };
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
// new Date(ano, mes, 0) usa mes como índice do MÊS SEGUINTE (Date é 0-indexed) —
// dia 0 desse mês seguinte é o último dia do mês humano "mes".
function ultimoDiaDoMes(ano, mes) { return new Date(ano, mes, 0).getDate(); }
function formatarDataBR(ano, mes, dia) { return `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${ano}`; }

// --- intercompany Rampa↔TF ---
// Rampa vende pra TF abaixo do custo; em contrapartida a TF paga algumas
// despesas da Rampa (e, mais raro, o inverso também acontece). Decisão do
// Rafael (2026-11-21): separar esses lançamentos numa coluna própria no DRE
// das duas empresas, sem mudar o total que já existia (total = operacional +
// intercompany — ver montarDRE).
//   - Receita/CMV da Rampa: automático — toda nota de venda pro cliente TF
//     (cadastro na Tiny da Rampa: "TF COMERCIO E SERVICOS LTDA", id 893415936,
//     CNPJ 51.251.441/0001-05) marca intercompany=true sozinho, todo sync.
//   - Despesas de QUALQUER empresa (titulo_tipo=pagar): nunca automático —
//     não tem padrão (nome de fornecedor varia) — só manual, via
//     acao=marcar-intercompany no handler principal. Por isso o campo
//     `intercompany` nunca entra no payload do lote nos dois ramos de
//     contas-pagar: fica de fora do upsert, que preserva o que já tiver no
//     banco (ver "Bug de acumulação" — upsert com merge-duplicates só
//     sobrescreve coluna que estiver no payload).
const ID_CLIENTE_TF_NA_RAMPA = "893415936";
const CNPJ_TF = "51251441000105";
function limparCnpj(v) { return String(v || "").replace(/\D/g, ""); }

// --- CMV (custo da mercadoria vendida): itens de nota de venda × custo do produto ---
// Ver CLAUDE.md "Módulo Financeiro (DRE)" — grupos 4.01/4.02 antes vinham de
// contas-pagar (pagamento de compra), o que o Rafael pediu pra tirar do DRE
// (2026-11-20): compra não é custo da venda. O cálculo certo é por nota
// emitida: quantidade vendida × custo do produto na Tiny. Só cobre 4.01
// (Estoques) por enquanto — 4.02 (Insumos de Serviços) continua manual.
//
// Custo do produto: NUNCA busca na Olist aqui — vem de estoque_catalogo
// (coluna custo_atual, já capturada de graça pelo sync diário de Estoque, ver
// api/estoque-sync-diario.js) mais a tabela financeiro_custo_mensal, que
// congela o custo por produto/mês (2026-11-22, correção de bug real):
//   - mês atual (ainda aberto): usa sempre custo_atual (o mês ainda não tem
//     "custo final", é esperado seguir o que estiver na Tiny agora).
//   - mês anterior (ainda dentro da janela de 2 meses reprocessada): usa o
//     custo CONGELADO desse produto nesse mês/empresa, se já existir; se não
//     existir ainda (primeira vez que esse produto aparece no mês anterior),
//     congela agora com o custo_atual do momento e nunca mais toca nisso —
//     auto-recuperável contra cron perdido, sem depender de cair exatamente
//     no último dia do mês. Isso evita o bug original: mudar o custo de um
//     produto em novembro não pode retroagir e mudar o CMV de outubro, que já
//     foi fechado com o custo que era real em outubro.
//
// Produto sem custo cadastrado conta como custo 0 nesse item (em vez de
// travar o cálculo todo) — enquanto o cadastro de custos não estiver completo
// na Tiny, o CMV fica subestimado, não errado por estimativa.
const SITUACOES_INVALIDAS_NOTA_VENDA_V2 = ["1", "3", "5", "10"]; // Pendente, Cancelada, Rejeitada, Denegada
function ehErroSemResultadosV2(erro) {
  return String(erro?.erros?.[0]?.erro || "").toLowerCase().includes("não retornou");
}
async function listarNotasVendaV2(tokenV2, dataInicialBR, dataFinalBR) {
  const todas = [];
  let pagina = 1;
  while (true) {
    const body = new URLSearchParams({
      token: tokenV2, formato: "JSON", tipoNota: "S",
      dataInicial: dataInicialBR, dataFinal: dataFinalBR, pagina: String(pagina),
    }).toString();
    const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/notas.fiscais.pesquisa.php", body,
      { "Content-Type": "application/x-www-form-urlencoded" });
    const data = parseJSON(r.text);
    if (data.retorno?.status === "Erro") {
      if (ehErroSemResultadosV2(data.retorno)) break;
      throw new Error(data.retorno.erros?.[0]?.erro || "Erro ao pesquisar notas fiscais");
    }
    const lista = (data.retorno?.notas_fiscais || []).map(n => n.nota_fiscal).filter(Boolean);
    todas.push(...lista);
    if (lista.length < 100) break;
    pagina++;
    await sleep(600);
  }
  return todas.filter(n => !SITUACOES_INVALIDAS_NOTA_VENDA_V2.includes(String(n.situacao)));
}
async function buscarDetalheNotaVendaV2(tokenV2, id) {
  const body = new URLSearchParams({ token: tokenV2, id: String(id), formato: "JSON" }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/nota.fiscal.obter.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno?.status === "Erro") {
    throw new Error(data.retorno.erros?.[0]?.erro || `erro ao obter nota ${id}`);
  }
  return data.retorno?.nota_fiscal || null;
}
// Custo atual de cada produto do catálogo (coluna custo_atual, preenchida de
// graça pelo sync diário de Estoque — ver api/estoque-sync-diario.js) — uma
// leitura só no Supabase pra empresa inteira, nada de bater na Olist produto
// a produto aqui (era assim que o antigo buscarCustoProdutoV2 fazia).
async function lerCustoAtualCatalogo(empresa) {
  const mapa = new Map();
  const limit = 1000;
  let offset = 0;
  while (true) {
    const r = await httpsRequest("GET", supaHost(),
      `/rest/v1/estoque_catalogo?empresa=eq.${empresa}&select=produto_id,custo_atual&limit=${limit}&offset=${offset}`,
      null, supaHeaders);
    const linhas = parseJSON(r.text);
    if (!Array.isArray(linhas)) break;
    linhas.forEach(l => mapa.set(Number(l.produto_id), Number(l.custo_atual) || 0));
    if (linhas.length < limit) break;
    offset += limit;
  }
  return mapa;
}
// Custos já congelados do mês anterior (financeiro_custo_mensal) — só esse
// mês precisa, é o único que pode estar "fechando" nesta chamada.
async function lerCustoCongeladoMes(empresa, ano, mes) {
  const mapa = new Map();
  const r = await httpsRequest("GET", supaHost(),
    `/rest/v1/financeiro_custo_mensal?empresa=eq.${empresa}&ano=eq.${ano}&mes=eq.${mes}&select=produto_id,custo`,
    null, supaHeaders);
  const linhas = parseJSON(r.text);
  if (Array.isArray(linhas)) linhas.forEach(l => mapa.set(Number(l.produto_id), Number(l.custo) || 0));
  return mapa;
}
// Grava os congelamentos novos descobertos nesta chamada. ignore-duplicates
// (nunca merge-duplicates): uma vez congelado um produto/mês, a linha é
// definitiva — se outra chamada (do mesmo dia ou de dias seguintes, enquanto
// esse mês ainda for "mês anterior") tentar congelar de novo, o insert é
// ignorado e o valor original permanece intocado.
async function salvarCongelamentos(novosCongelamentos) {
  if (!novosCongelamentos.size) return;
  const payload = JSON.stringify([...novosCongelamentos.values()]);
  await httpsRequest("POST", supaHost(), "/rest/v1/financeiro_custo_mensal?on_conflict=empresa,produto_id,ano,mes", payload,
    { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=ignore-duplicates,return=minimal" });
  novosCongelamentos.clear();
}
// Calcula o CMV de uma nota (soma quantidade × custo de cada item) e devolve
// também quantos itens ficaram sem custo cadastrado, só pra log/diagnóstico.
// `obterCusto(idProduto)` resolve o custo certo (atual ou congelado, ver
// comentário acima sobre congelamento) — nunca busca nada na Olist aqui.
async function calcularCmvNota(tokenV2, idNota, obterCusto) {
  const nota = await buscarDetalheNotaVendaV2(tokenV2, idNota);
  let valor = 0, semCusto = 0, totalItens = 0;
  for (const itWrap of (nota?.itens || [])) {
    const it = itWrap?.item;
    const idProduto = it?.id_produto;
    const quantidade = Number(it?.quantidade) || 0;
    if (!it) continue;
    totalItens++;
    if (!idProduto) { semCusto++; continue; }
    const custo = obterCusto(idProduto);
    if (!custo) { semCusto++; continue; }
    valor += quantidade * custo;
  }
  const intercompanyTF = limparCnpj(nota?.cliente?.cpf_cnpj) === CNPJ_TF;
  return { valor, semCusto, totalItens, intercompanyTF, clienteNome: nota?.cliente?.nome || null };
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

  // A Vercel SEMPRE dispara o cron via GET (confirmado na documentação
  // oficial), marcando a chamada com o header `x-vercel-cron-schedule` (não
  // `x-vercel-cron`, que não existe e nunca bateu aqui). Por isso essa
  // checagem tem que vir ANTES da leitura de status abaixo — caso contrário
  // TODO disparo do cron caía no "só lê status" e nunca processava nada
  // (achado em produção, 2026-11-20 — ver CLAUDE.md "Vercel serverless —
  // limitações", mesmo bug do estoque-sync-diario.js).
  const vercelCron = req.headers["x-vercel-cron-schedule"];

  // GET só lê o status (usado por um eventual botão "sincronizar agora" no
  // frontend, igual ao de Estoque) — não dispara processamento. Só entra
  // aqui quando NÃO é o cron de verdade.
  if (!vercelCron && req.method === "GET") {
    try {
      const status = await lerStatusSync(empresa);
      return res.status(200).json({ ok: true, status });
    } catch (e) {
      return res.status(500).json({ erro: e.message });
    }
  }

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
    const tokenV2 = getConfigEmpresa(empresa).tokenV2;
    const planoContas = await lerPlanoContasSync();
    const grupoCmv = Object.values(planoContas).find(l => l.fonte_tiny === "notas_fiscais_itens")?.codigo_grupo || null;

    // Categorias são rápidas (uma lista paginada só) — sempre atualiza antes
    // de montar a fila, pra qualquer categoria nova já entrar classificada.
    await syncCategorias(empresa, accessToken);
    const categorias = await lerCategoriasMapeadas(empresa);

    const hoje = new Date();
    const mesAtual = { ano: hoje.getFullYear(), mes: hoje.getMonth() + 1 };
    const mesAnterior = mesAlvoAnterior(mesAtual.ano, mesAtual.mes);
    const periodos = [mesAtual, mesAnterior]; // reprocessa os 2 últimos meses, não assume mês fechado como imutável

    // Custo pro CMV: nunca busca na Olist aqui (ver comentário em cima de
    // calcularCmvNota) — lê o custo atual de todo o catálogo de uma vez e o
    // que já estiver congelado do mês anterior, de uma vez cada.
    const custoAtualPorProduto = grupoCmv ? await lerCustoAtualCatalogo(empresa) : new Map();
    const custoCongeladoMesAnterior = grupoCmv ? await lerCustoCongeladoMes(empresa, mesAnterior.ano, mesAnterior.mes) : new Map();
    const novosCongelamentos = new Map(); // chave produtoId -> linha pra inserir em financeiro_custo_mensal
    function obterCustoProduto(idProduto, ano, mes) {
      const custoAtual = custoAtualPorProduto.get(Number(idProduto)) || 0;
      if (ano !== mesAnterior.ano || mes !== mesAnterior.mes) return custoAtual; // mês atual (aberto): sempre o custo de agora
      if (custoCongeladoMesAnterior.has(Number(idProduto))) return custoCongeladoMesAnterior.get(Number(idProduto));
      // primeira vez que esse produto aparece no mês anterior: congela agora
      // com o custo atual e nunca mais muda (ver salvarCongelamentos).
      custoCongeladoMesAnterior.set(Number(idProduto), custoAtual);
      novosCongelamentos.set(Number(idProduto), { empresa, produto_id: idProduto, ano, mes, custo: custoAtual });
      return custoAtual;
    }

    if (!status || !status.em_andamento || iniciadoHaMuito) {
      const filaReceita = [];
      const filaPagar = [];
      const filaCmv = [];
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

        if (grupoCmv) {
          const iniBR = formatarDataBR(p.ano, p.mes, 1);
          const fimBR = formatarDataBR(p.ano, p.mes, ultimoDiaDoMes(p.ano, p.mes));
          const notasVenda = await listarNotasVendaV2(tokenV2, iniBR, fimBR);
          notasVenda.forEach(n => filaCmv.push({ id: n.id, ano: p.ano, mes: p.mes }));
          await sleep(600);
        }
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
        pendentes: { receita: filaReceita, pagar: filaPagarUnica, cmv: filaCmv },
        total: filaReceita.length + filaPagarUnica.length + filaCmv.length,
        processados: 0,
        iniciado_em: new Date().toISOString(),
        concluido_em: null,
        ultimo_erro: null,
      };
      await salvarStatusSync(empresa, status);
      console.log(`[financeiro-sync:${empresa}] execução nova: ${filaReceita.length} contas a receber + ${filaPagarUnica.length} contas a pagar + ${filaCmv.length} notas de venda (cmv) a classificar`);
    } else {
      console.log(`[financeiro-sync:${empresa}] retomando: ${status.pendentes.receita.length} receber + ${status.pendentes.pagar.length} pagar + ${(status.pendentes.cmv || []).length} cmv pendentes`);
    }

    const filaReceita = [...status.pendentes.receita];
    const filaPagar = [...status.pendentes.pagar];
    const filaCmv = [...(status.pendentes.cmv || [])]; // (|| []) cobre execução que ficou em_andamento de antes desse campo existir
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
            const intercompany = empresa === "rampa" && String(d.cliente?.id) === ID_CLIENTE_TF_NA_RAMPA;
            const descricao = d.cliente?.nome || d.historico || null;
            lote.push({
              ano: item.ano, mes: item.mes, codigo_grupo: codigoGrupo, categoria_id: catId ?? null,
              origem: "tiny_competencia", regime: "competencia",
              titulo_tipo: "receber", titulo_id: item.id, valor: Number(d.valor) || 0,
              intercompany, descricao,
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

          // descricao é só informativo (pra tela de apontamento manual — ver
          // acao=titulos) — sempre recalculado no sync, nunca preservado como o
          // intercompany, que fica de fora do payload nos dois ramos abaixo.
          const descricao = d.contato?.nome || d.historico || null;
          if (linha && linha.regime === "competencia" && linha.fonte_tiny === "contas_pagar") {
            // Imposto sobre venda (5.01): conta no mês da dataCompetencia real, não do vencimento usado pra listar.
            if (d.dataCompetencia === formatarYYYYMM(item.ano, item.mes)) {
              lote.push({
                ano: item.ano, mes: item.mes, codigo_grupo: codigoGrupo, categoria_id: viaHistorico ? null : catId,
                origem: viaHistorico ? "tiny_historico" : "tiny_competencia", regime: "competencia",
                titulo_tipo: "pagar", titulo_id: item.id, valor: Number(d.valor) || 0,
                descricao,
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
                descricao,
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
        status.processados = status.total - filaReceita.length - filaPagar.length - filaCmv.length;
        await salvarStatusSync(empresa, status);
        console.log(`[financeiro-sync:${empresa}] checkpoint (pagar): ${status.processados}/${status.total}`);
        processadosDesdeCheckpoint = 0;
      }
    }

    let semCustoNoLote = 0, itensNoLote = 0;
    while (grupoCmv && filaCmv.length > 0 && (Date.now() - inicioExecucao) < ORCAMENTO_TOTAL_MS) {
      const item = filaCmv.shift();
      await sleep(600);
      try {
        const obterCusto = (idProduto) => obterCustoProduto(idProduto, item.ano, item.mes);
        const { valor, semCusto, totalItens, intercompanyTF, clienteNome } = await calcularCmvNota(tokenV2, item.id, obterCusto);
        semCustoNoLote += semCusto;
        itensNoLote += totalItens;
        lote.push({
          ano: item.ano, mes: item.mes, codigo_grupo: grupoCmv, categoria_id: null,
          origem: "tiny_notas_itens", regime: "competencia",
          titulo_tipo: "cmv", titulo_id: item.id, valor,
          intercompany: empresa === "rampa" && intercompanyTF, descricao: clienteNome,
        });
      } catch (erroRede) {
        console.error(`[financeiro-sync] erro na nota de venda (cmv) ${item.id}: ${erroRede.message}`);
        item.tentativas = (item.tentativas || 0) + 1;
        if (item.tentativas <= MAX_TENTATIVAS_POR_TITULO) filaCmv.push(item);
      }
      processadosDesdeCheckpoint++;
      if (processadosDesdeCheckpoint >= SALVAR_PROGRESSO_A_CADA) {
        await salvarLote();
        await salvarCongelamentos(novosCongelamentos);
        status.pendentes.cmv = filaCmv;
        status.processados = status.total - filaReceita.length - filaPagar.length - filaCmv.length;
        await salvarStatusSync(empresa, status);
        console.log(`[financeiro-sync:${empresa}] checkpoint (cmv): ${status.processados}/${status.total}` +
          (itensNoLote ? ` — ${semCustoNoLote}/${itensNoLote} itens sem custo cadastrado neste lote` : ""));
        processadosDesdeCheckpoint = 0;
        semCustoNoLote = 0; itensNoLote = 0;
      }
    }

    await salvarLote();
    await salvarCongelamentos(novosCongelamentos);
    status.pendentes = { receita: filaReceita, pagar: filaPagar, cmv: filaCmv };
    status.processados = status.total - filaReceita.length - filaPagar.length - filaCmv.length;

    if (filaReceita.length === 0 && filaPagar.length === 0 && filaCmv.length === 0) {
      status.em_andamento = false;
      status.concluido_em = new Date().toISOString();
      await salvarStatusSync(empresa, status);
      console.log(`[financeiro-sync:${empresa}] concluído: ${status.total} títulos classificados em ${Math.round((Date.now() - inicioExecucao) / 1000)}s`);
      return res.status(200).json({ ok: true, concluido: true, total: status.total });
    }

    await salvarStatusSync(empresa, status);
    console.error(`[financeiro-sync:${empresa}] orçamento de tempo esgotado: ${status.processados}/${status.total} — precisa de outra chamada pra terminar`);
    return res.status(200).json({ ok: true, concluido: false, processados: status.processados, restante: filaReceita.length + filaPagar.length + filaCmv.length });

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
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

      if (acao === "titulos") {
        // Drill-down por grupo/mês/empresa — alimenta a tela de apontamento
        // manual do intercompany (um ou mais codigo_grupo, separados por vírgula,
        // pra cobrir uma linha_dre que tenha vários grupos).
        const empresaTit = String(req.query.empresa || "rampa").toLowerCase();
        const anoTit = parseInt(req.query.ano, 10);
        const mesTit = parseInt(req.query.mes, 10);
        const grupos = String(req.query.codigo_grupo || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!anoTit || !mesTit || !grupos.length) {
          return res.status(400).json({ erro: "empresa, ano, mes e codigo_grupo são obrigatórios" });
        }
        const filtroGrupo = grupos.length === 1
          ? `codigo_grupo=eq.${encodeURIComponent(grupos[0])}`
          : `codigo_grupo=in.(${grupos.map(encodeURIComponent).join(",")})`;
        const r = await httpsRequest("GET", supaHost(),
          `/rest/v1/financeiro_mensal?empresa=eq.${empresaTit}&ano=eq.${anoTit}&mes=eq.${mesTit}&${filtroGrupo}` +
          `&select=titulo_tipo,titulo_id,codigo_grupo,valor,origem,descricao,intercompany&order=valor.desc`,
          null, supaHeaders);
        const data = parseJSON(r.text);
        return res.status(200).json(Array.isArray(data) ? data : []);
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

    if (req.method === "PATCH" && req.query.acao === "marcar-intercompany") {
      // Apontamento manual (ambas empresas, titulo_tipo=pagar na prática — ver
      // CLAUDE.md "Intercompany Rampa↔TF"): nunca sobrescrito pelo sync diário,
      // que não inclui esse campo no payload das despesas (ver executarSyncDiario).
      const { empresa, titulo_tipo, titulo_id, intercompany } = parseBody(req.body);
      if (!empresa || !titulo_tipo || !titulo_id || typeof intercompany !== "boolean") {
        return res.status(400).json({ erro: "empresa, titulo_tipo, titulo_id e intercompany (boolean) são obrigatórios" });
      }
      const payload = JSON.stringify({ intercompany });
      const r = await httpsRequest("PATCH", supaHost(),
        `/rest/v1/financeiro_mensal?empresa=eq.${encodeURIComponent(String(empresa).toLowerCase())}` +
        `&titulo_tipo=eq.${encodeURIComponent(titulo_tipo)}&titulo_id=eq.${encodeURIComponent(titulo_id)}`,
        payload, { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
      if (r.status >= 400) return res.status(400).json({ erro: r.text });
      return res.status(200).json({ ok: true });
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
