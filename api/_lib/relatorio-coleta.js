// Lógica de coleta de dados da Olist pro Relatório de Vendas — compartilhada
// entre api/relatorios.js (acionado pela tela, período grande, com barra de
// progresso no navegador) e api/relatorio-sync-diario.js (cron automático,
// período curto, roda sozinho no servidor).
const https = require("https");

const TOKEN_V2 = process.env.OLIST_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

// Serviços que não devem entrar no relatório (ex: cobrança interna, não é venda)
const DESCRICOES_SERVICO_EXCLUIDAS = ["serviço de apoio na área de vendas"];

// situação: 1=Pendente, 3=Cancelada, 5=Rejeitada, 10=Denegada — nunca contam.
// Tudo mais (2=Emitida, 6=Autorizada, 7=Emitida DANFE, 8=Registrada, etc) conta como válida —
// a Olist usa mais códigos de "emitida com sucesso" do que a documentação lista.
const SITUACOES_INVALIDAS = ["1", "3", "5", "10"];
// finalidade: 4, 7, 8 = Devolução/Retorno
const FINALIDADES_DEVOLUCAO = ["4", "7", "8"];
// situação de nota de serviço: 1=Pendente, 3=Cancelada — nunca contam.
// 2=Emitida, 4=Enviada (aguardando recibo) contam como válidas.
const SITUACOES_INVALIDAS_SERVICO = ["1", "3"];

// Pedidos de representação: a NF é emitida pelo fornecedor, então não existe
// nota fiscal nossa pra esse pedido (id_nota_fiscal = 0). Identificados por
// situação "Faturado" + marcador "rep". A data de faturamento considerada é a
// "data prevista" do pedido, não a data de cadastro (que é o que a Olist
// permite filtrar na busca) — por isso buscamos com uma margem de dias antes/
// depois do período e filtramos pela data prevista depois.
const MARCADOR_REPRESENTACAO = "rep";
const MARGEM_DIAS_REPRESENTACAO = 30;

// Pedidos com a tag "aguia": vendidos por aqui mas faturados por outro CNPJ
// nosso (outra conta na Olist), então também não têm NF nessa conta.
const MARCADOR_AGUIA = "aguia";
const MARGEM_DIAS_AGUIA = 30;

// Notas de venda com marcador "vf-faturamento" são só a cobrança antecipada de
// uma venda futura — não contam. A entrega/venda de fato é uma nota separada,
// com marcador "vf-entrega" (essa sim conta, normalmente). A Olist não deixa
// filtrar notas fiscais por marcador na busca, então isso só dá pra saber
// olhando o detalhe de cada nota.
const MARCADOR_VENDA_FUTURA_EXCLUIR = "vf-faturamento";

function httpsRequest(method, hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      const chunks = []; res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseJSON(text) { try { return JSON.parse(text); } catch { return {}; } }

// A Olist usa códigos de erro diferentes pra "nenhum resultado" dependendo do
// endpoint (6 em notas fiscais, 20 em pedidos) — mais confiável checar pela
// mensagem do que decorar um código por endpoint.
function ehErroSemResultados(erro) {
  return String(erro?.erros?.[0]?.erro || "").toLowerCase().includes("não retornou");
}

// Normaliza número de nota pra comparação (remove zeros à esquerda) —
// assim "012662" cadastrado numa alteração casa com "12662" digitado por engano.
function normalizarNumero(numero) {
  const n = parseInt(String(numero).replace(/\D/g, ""), 10);
  return Number.isNaN(n) ? String(numero).trim() : String(n);
}

function formatarDataBR(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function paraIso(dataBR) {
  const m = String(dataBR || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseDataBR(str) {
  const m = String(str || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function somarDiasBR(dataStrBR, dias) {
  const d = parseDataBR(dataStrBR);
  d.setDate(d.getDate() + dias);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function formatarDataBRDate(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

function hojeBR() {
  return formatarDataBRDate(new Date());
}

// ── DE-PARA vendedor → responsável (tabela vendedor_responsavel) ─────────
// Uma linha "tipo=*" vale como padrão pro vendedor; uma linha com tipo
// específico (ex: "representacao") tem prioridade só pra esse tipo de nota —
// é o caso da Patrícia Curvello, que é "CARTEIRA 5 (C/M)" nas vendas normais
// mas "CARTEIRA 5" nas vendas de representação.
async function buscarMapeamentoResponsavel() {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    "/rest/v1/vendedor_responsavel?select=vendedor,tipo,responsavel",
    null, supaHeaders);
  const data = parseJSON(r.text);
  return Array.isArray(data) ? data : [];
}

function resolverResponsavel(mapeamento, vendedor, tipo) {
  const especifico = mapeamento.find(m => m.vendedor === vendedor && m.tipo === tipo);
  if (especifico) return especifico.responsavel;
  const padrao = mapeamento.find(m => m.vendedor === vendedor && m.tipo === "*");
  if (padrao) return padrao.responsavel;
  return vendedor || "Sem responsável";
}

// ── Correções manuais (tela de Alterações) ───────────────────────────────
async function buscarAlteracoes(tipoNota) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    `/rest/v1/alteracoes_relatorio?tipo_nota=eq.${tipoNota}&select=numero_nota,vendedor,data_emissao`,
    null, supaHeaders);
  const data = parseJSON(r.text);
  const mapa = {};
  (Array.isArray(data) ? data : []).forEach(a => { mapa[normalizarNumero(a.numero_nota)] = a; });
  return mapa;
}

// ── Cliente: código + razão social (pra cache), com memoização por CNPJ ──
const cacheClientePorCnpj = {};
async function buscarClientePorCnpj(cnpj) {
  const limpo = String(cnpj || "").replace(/\D/g, "");
  if (!limpo) return null;
  if (cacheClientePorCnpj[limpo]) return cacheClientePorCnpj[limpo];
  const body = new URLSearchParams({ token: TOKEN_V2, formato: "JSON", cpf_cnpj: limpo }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/contatos.pesquisa.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  const contato = data.retorno?.contatos?.[0]?.contato;
  const info = contato ? { codigo: contato.codigo, razaoSocial: contato.nome } : null;
  cacheClientePorCnpj[limpo] = info;
  return info;
}

// ── Notas fiscais (produto/devolução) ────────────────────────────────────
async function buscarPaginaNotas(tipoNota, dataInicial, dataFinal, pagina) {
  const body = new URLSearchParams({
    token: TOKEN_V2, formato: "JSON",
    tipoNota, dataInicial, dataFinal, pagina: String(pagina),
  }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/notas.fiscais.pesquisa.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno && data.retorno.status === "Erro") {
    if (ehErroSemResultados(data.retorno)) return [];
    throw new Error(data.retorno.erros?.[0]?.erro || "Erro ao pesquisar notas fiscais");
  }
  return data.retorno?.notas_fiscais || [];
}

async function buscarTodasNotas(tipoNota, dataInicial, dataFinal) {
  const todas = [];
  let pagina = 1;
  while (true) {
    const lista = await buscarPaginaNotas(tipoNota, dataInicial, dataFinal, pagina);
    lista.forEach(n => { if (n.nota_fiscal) todas.push(n.nota_fiscal); });
    if (lista.length < 100) break;
    pagina++;
    await sleep(600);
  }
  return todas.filter(n => !SITUACOES_INVALIDAS.includes(String(n.situacao)));
}

async function buscarDetalheNotaFiscal(id) {
  const body = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/nota.fiscal.obter.php",
    body, { "Content-Type": "application/x-www-form-urlencoded" });
  return parseJSON(r.text).retorno?.nota_fiscal || null;
}

function temMarcador(notaOuPedido, marcador) {
  const marcadores = (notaOuPedido?.marcadores || []).map(m => (m.marcador?.descricao || "").toLowerCase());
  return marcadores.includes(marcador.toLowerCase());
}

// ── Notas de serviço ──────────────────────────────────────────────────────
async function buscarPaginaNotasServico(dataInicial, dataFinal, pagina) {
  const body = new URLSearchParams({
    token: TOKEN_V2, formato: "JSON",
    dataInicial, dataFinal, pagina: String(pagina),
  }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/notas.servico.pesquisa.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno && data.retorno.status === "Erro") {
    if (ehErroSemResultados(data.retorno)) return [];
    throw new Error(data.retorno.erros?.[0]?.erro || "Erro ao pesquisar notas de serviço");
  }
  return data.retorno?.notas_servico || [];
}

async function buscarTodasNotasServico(dataInicial, dataFinal) {
  const todas = [];
  let pagina = 1;
  while (true) {
    const lista = await buscarPaginaNotasServico(dataInicial, dataFinal, pagina);
    lista.forEach(n => { if (n.nota_servico) todas.push(n.nota_servico); });
    if (lista.length < 100) break;
    pagina++;
    await sleep(600);
  }
  return todas.filter(n => !SITUACOES_INVALIDAS_SERVICO.includes(String(n.situacao)));
}

async function buscarDetalheNotaServico(id) {
  const body = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/nota.servico.obter.php",
    body, { "Content-Type": "application/x-www-form-urlencoded" });
  return parseJSON(r.text).retorno?.nota_fiscal || null;
}

// ── Pedidos (representação / aguia) ──────────────────────────────────────
async function buscarPaginaPedidos(situacao, marcador, dataInicial, dataFinal, pagina) {
  const body = new URLSearchParams({
    token: TOKEN_V2, formato: "JSON",
    situacao, marcador, dataInicial, dataFinal, pagina: String(pagina),
  }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/pedidos.pesquisa.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno && data.retorno.status === "Erro") {
    if (ehErroSemResultados(data.retorno)) return [];
    throw new Error(data.retorno.erros?.[0]?.erro || "Erro ao pesquisar pedidos");
  }
  return data.retorno?.pedidos || [];
}

async function buscarTodosPedidos(situacao, marcador, dataInicial, dataFinal) {
  const todos = [];
  let pagina = 1;
  while (true) {
    const lista = await buscarPaginaPedidos(situacao, marcador, dataInicial, dataFinal, pagina);
    lista.forEach(p => { if (p.pedido) todos.push(p.pedido); });
    if (lista.length < 100) break;
    pagina++;
    await sleep(600);
  }
  return todos;
}

async function buscarDetalhePedido(id) {
  const body = new URLSearchParams({ token: TOKEN_V2, id: String(id), formato: "JSON" }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br", "/api2/pedido.obter.php",
    body, { "Content-Type": "application/x-www-form-urlencoded" });
  return parseJSON(r.text).retorno?.pedido || null;
}

// ── Devolução: referência à nota de venda original ───────────────────────
function extrairReferenciaOrigem(obs) {
  const mNumero = (obs || "").match(/N[uú]mero da NF-e referenciada:\s*(\d+)/i);
  const mData = (obs || "").match(/Data de emiss[ãa]o da NF-e referenciada:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const mChave = (obs || "").match(/Chave de acesso da NF-e referenciada:\s*(\d+)/i);
  if (!mNumero || !mData) return null;
  return { numero: mNumero[1], data: mData[1], chave: mChave ? mChave[1] : null };
}

async function buscarVendedorDaNotaOrigem(referencia) {
  const body = new URLSearchParams({
    token: TOKEN_V2, formato: "JSON",
    tipoNota: "S", numero: referencia.numero,
    dataInicial: referencia.data, dataFinal: referencia.data,
  }).toString();
  const r = await httpsRequest("POST", "api.tiny.com.br",
    "/api2/notas.fiscais.pesquisa.php", body,
    { "Content-Type": "application/x-www-form-urlencoded" });
  const data = parseJSON(r.text);
  if (data.retorno?.status === "Erro") return null;
  const candidatas = (data.retorno?.notas_fiscais || []).map(n => n.nota_fiscal);
  const origem = referencia.chave
    ? candidatas.find(n => n.chave_acesso === referencia.chave)
    : candidatas[0];
  return origem?.nome_vendedor || null;
}

// ── Cache (Supabase) ──────────────────────────────────────────────────────
// Substitui (apaga e recria) as linhas de um tipo dentro do período informado
// — garante que notas que deixaram de existir/valer (ex: devolução cancelada,
// pedido "aguia" que ganhou NF própria) somem do relatório na próxima sync.
async function salvarNoCache(tipo, dataInicial, dataFinal, linhas) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const isoInicial = paraIso(dataInicial);
  const isoFinal = paraIso(dataFinal);

  await httpsRequest("DELETE", supaHost,
    `/rest/v1/relatorio_cache?tipo=eq.${tipo}&data=gte.${isoInicial}&data=lte.${isoFinal}`,
    null, { ...supaHeaders, Prefer: "return=minimal" });

  if (linhas.length > 0) {
    const mapeamento = await buscarMapeamentoResponsavel();
    const payload = JSON.stringify(linhas.map(l => ({
      tipo,
      numero_nota: String(l.numero),
      id_olist: l.id ? String(l.id) : null,
      data: paraIso(l.data),
      vendedor: l.vendedor,
      responsavel: resolverResponsavel(mapeamento, l.vendedor, tipo),
      valor: l.valor,
      cliente_cnpj: l.clienteCnpj || null,
      cliente_codigo: l.clienteCodigo || null,
      cliente_razao_social: l.clienteRazaoSocial || null,
    })));
    await httpsRequest("POST", supaHost, "/rest/v1/relatorio_cache", payload,
      { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "resolution=merge-duplicates,return=minimal" });
  }

  await atualizarStatusCache(isoInicial);
}

// Guarda a data mais antiga já sincronizada (nunca "recua" o valor pra uma
// data mais recente, mesmo que um sync posterior cubra um período menor).
async function atualizarStatusCache(isoInicialDesteSync) {
  const supaHost = SUPABASE_URL.replace("https://", "");
  const r = await httpsRequest("GET", supaHost,
    "/rest/v1/relatorio_cache_status?id=eq.1&select=sincronizado_desde",
    null, supaHeaders);
  const atual = parseJSON(r.text)?.[0]?.sincronizado_desde || null;
  const novoSincronizadoDesde = (!atual || isoInicialDesteSync < atual) ? isoInicialDesteSync : atual;

  const payload = JSON.stringify({
    ultima_atualizacao: new Date().toISOString(),
    sincronizado_desde: novoSincronizadoDesde,
  });
  await httpsRequest("PATCH", supaHost, "/rest/v1/relatorio_cache_status?id=eq.1",
    payload, { ...supaHeaders, "Content-Length": Buffer.byteLength(payload), Prefer: "return=minimal" });
}

module.exports = {
  TOKEN_V2, SUPABASE_URL, SUPABASE_KEY, supaHeaders,
  DESCRICOES_SERVICO_EXCLUIDAS, FINALIDADES_DEVOLUCAO,
  MARCADOR_REPRESENTACAO, MARGEM_DIAS_REPRESENTACAO,
  MARCADOR_AGUIA, MARGEM_DIAS_AGUIA, MARCADOR_VENDA_FUTURA_EXCLUIR,
  httpsRequest, sleep, parseJSON, normalizarNumero,
  formatarDataBR, paraIso, parseDataBR, somarDiasBR, formatarDataBRDate, hojeBR,
  buscarAlteracoes, buscarClientePorCnpj, temMarcador,
  buscarMapeamentoResponsavel, resolverResponsavel,
  buscarTodasNotas, buscarTodasNotasServico, buscarDetalheNotaServico, buscarDetalheNotaFiscal,
  buscarTodosPedidos, buscarDetalhePedido,
  extrairReferenciaOrigem, buscarVendedorDaNotaOrigem,
  salvarNoCache,
};
