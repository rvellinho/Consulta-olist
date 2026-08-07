// Atualização automática do cache do Relatório de Vendas — roda sozinho via
// cron (vercel.json), sem navegador. Cobre só os últimos 7 dias (janela curta
// de propósito: com navegador dá pra fazer loop longo, mas aqui dentro do
// serverless o tempo de execução é limitado). Reaproveita a mesma lógica de
// coleta usada pela tela (api/_lib/relatorio-coleta.js).
const {
  TOKEN_V2,
  MARCADOR_REPRESENTACAO, MARGEM_DIAS_REPRESENTACAO,
  MARCADOR_AGUIA, MARGEM_DIAS_AGUIA, MARCADOR_VENDA_FUTURA_EXCLUIR,
  DESCRICOES_SERVICO_EXCLUIDAS, FINALIDADES_DEVOLUCAO,
  httpsRequest, sleep, parseJSON, normalizarNumero, formatarDataBR, parseDataBR, somarDiasBR, hojeBR,
  buscarAlteracoes, buscarClientePorCnpj, temMarcador,
  buscarTodasNotas, buscarTodasNotasServico, buscarDetalheNotaServico, buscarDetalheNotaFiscal,
  buscarTodosPedidos, buscarDetalhePedido,
  extrairReferenciaOrigem, buscarVendedorDaNotaOrigem,
  salvarNoCache,
} = require("./_lib/relatorio-coleta");

const DIAS_JANELA_DIARIA = 7;

async function coletarProdutos(dataInicial, dataFinal) {
  const notas = await buscarTodasNotas("S", dataInicial, dataFinal);
  const alteracoes = await buscarAlteracoes("produto");
  const resultado = [];
  for (const n of notas) {
    await sleep(600);
    const detalhe = await buscarDetalheNotaFiscal(n.id);
    if (temMarcador(detalhe, MARCADOR_VENDA_FUTURA_EXCLUIR)) continue;
    const alt = alteracoes[normalizarNumero(n.numero)];
    resultado.push({
      numero: n.numero, id: n.id,
      data: alt?.data_emissao ? formatarDataBR(alt.data_emissao) : n.data_emissao,
      vendedor: alt?.vendedor || n.nome_vendedor || "Sem vendedor",
      valor: parseFloat(n.valor || 0),
      clienteCnpj: n.cliente?.cpf_cnpj || null,
      clienteRazaoSocial: n.cliente?.nome || null,
    });
  }
  return resultado;
}

async function coletarDevolucoes(dataInicial, dataFinal) {
  const entradas = await buscarTodasNotas("E", dataInicial, dataFinal);
  const alteracoes = await buscarAlteracoes("devolucao");
  const resultado = [];
  for (const entrada of entradas) {
    await sleep(600);
    const resp = await httpsRequest("POST", "api.tiny.com.br", "/api2/nota.fiscal.obter.php",
      new URLSearchParams({ token: TOKEN_V2, id: String(entrada.id), formato: "JSON" }).toString(),
      { "Content-Type": "application/x-www-form-urlencoded" });
    const nota = parseJSON(resp.text).retorno?.nota_fiscal;
    if (!nota) continue;
    const ehDevolucao = FINALIDADES_DEVOLUCAO.includes(String(nota.finalidade));
    if (!ehDevolucao) continue;

    let vendedor = null;
    const referencia = extrairReferenciaOrigem(nota.obs);
    if (referencia) {
      await sleep(400);
      vendedor = await buscarVendedorDaNotaOrigem(referencia);
    }
    const alt = alteracoes[normalizarNumero(nota.numero)];
    if (alt?.vendedor) vendedor = alt.vendedor;

    resultado.push({
      numero: nota.numero, id: nota.id,
      data: nota.data_emissao,
      vendedor: vendedor || "Sem vendedor",
      valor: parseFloat(nota.valor_nota || 0),
      clienteCnpj: nota.cliente?.cpf_cnpj || null,
      clienteRazaoSocial: nota.cliente?.nome || null,
    });
  }
  return resultado;
}

async function coletarServicos(dataInicial, dataFinal) {
  const notas = await buscarTodasNotasServico(dataInicial, dataFinal);
  const alteracoes = await buscarAlteracoes("servico");
  const resultado = [];
  for (const n of notas) {
    await sleep(600);
    const detalhe = await buscarDetalheNotaServico(n.id);
    const descricao = detalhe?.servico?.descricao || "";
    const excluido = DESCRICOES_SERVICO_EXCLUIDAS.some(d => descricao.toLowerCase().includes(d));
    if (excluido) continue;
    const alt = alteracoes[normalizarNumero(n.numero)];
    resultado.push({
      numero: n.numero, id: n.id,
      data: n.data_emissao,
      vendedor: alt?.vendedor || n.nome_vendedor || "Sem vendedor",
      valor: parseFloat(n.valor || 0),
      clienteCnpj: detalhe?.cliente?.cpf_cnpj || null,
      clienteRazaoSocial: detalhe?.cliente?.nome || null,
    });
  }
  return resultado;
}

async function coletarPedidosMarcados(marcador, margemDias, dataInicial, dataFinal, tipoAlteracao) {
  const inicioBuscado = somarDiasBR(dataInicial, -margemDias);
  const fimBuscado = somarDiasBR(dataFinal, margemDias);
  const pedidos = await buscarTodosPedidos("faturado", marcador, inicioBuscado, fimBuscado);

  const inicioPeriodo = parseDataBR(dataInicial);
  const fimPeriodo = parseDataBR(dataFinal);
  const noPeriodo = pedidos.filter(p => {
    const dp = parseDataBR(p.data_prevista);
    return dp && dp >= inicioPeriodo && dp <= fimPeriodo;
  });

  const alteracoes = await buscarAlteracoes(tipoAlteracao);
  const resultado = [];
  for (const p of noPeriodo) {
    await sleep(600);
    const detalhe = await buscarDetalhePedido(p.id);
    const temNotaFiscal = !!(detalhe && Number(detalhe.id_nota_fiscal) > 0);
    if (temNotaFiscal) continue;
    const alt = alteracoes[normalizarNumero(p.numero)];
    resultado.push({
      numero: p.numero, id: p.id,
      data: alt?.data_emissao ? formatarDataBR(alt.data_emissao) : p.data_prevista,
      vendedor: alt?.vendedor || p.nome_vendedor || "Sem vendedor",
      valor: parseFloat(p.valor || 0),
      clienteCnpj: detalhe?.cliente?.cpf_cnpj || null,
      clienteRazaoSocial: detalhe?.cliente?.nome || null,
    });
  }
  return resultado;
}

async function anexarCodigoCliente(linhas) {
  for (const l of linhas) {
    if (!l.clienteCnpj) continue;
    const info = await buscarClientePorCnpj(l.clienteCnpj);
    if (info) l.clienteCodigo = info.codigo;
  }
  return linhas;
}

module.exports = async (req, res) => {
  // Protege contra chamadas externas — só o cron da Vercel (ou um admin com o segredo) pode acionar.
  const segredo = process.env.CRON_SECRET;
  if (segredo && req.headers.authorization !== `Bearer ${segredo}`) {
    return res.status(401).json({ erro: "não autorizado" });
  }

  try {
    const hoje = hojeBR();
    const dataInicial = somarDiasBR(hoje, -DIAS_JANELA_DIARIA);
    const dataFinal = hoje;

    const produtos = await anexarCodigoCliente(await coletarProdutos(dataInicial, dataFinal));
    const aguia = await anexarCodigoCliente(await coletarPedidosMarcados(MARCADOR_AGUIA, MARGEM_DIAS_AGUIA, dataInicial, dataFinal, "aguia"));
    const devolucoes = await anexarCodigoCliente(await coletarDevolucoes(dataInicial, dataFinal));
    const servicos = await anexarCodigoCliente(await coletarServicos(dataInicial, dataFinal));
    const representacao = await anexarCodigoCliente(await coletarPedidosMarcados(MARCADOR_REPRESENTACAO, MARGEM_DIAS_REPRESENTACAO, dataInicial, dataFinal, "representacao"));

    await salvarNoCache("produto", dataInicial, dataFinal, produtos);
    await salvarNoCache("aguia", dataInicial, dataFinal, aguia);
    await salvarNoCache("devolucao", dataInicial, dataFinal, devolucoes);
    await salvarNoCache("servico", dataInicial, dataFinal, servicos);
    await salvarNoCache("representacao", dataInicial, dataFinal, representacao);

    return res.status(200).json({
      ok: true,
      periodo: { dataInicial, dataFinal },
      contagens: { produtos: produtos.length, aguia: aguia.length, devolucoes: devolucoes.length, servicos: servicos.length, representacao: representacao.length },
    });
  } catch (e) {
    return res.status(500).json({ erro: e.message, stack: e.stack });
  }
};
