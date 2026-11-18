// Regra de elegibilidade do relatorio de estoque — usada tanto pela consulta
// ao vivo (api/estoque.js) quanto pela sincronizacao diaria de cadastro
// (api/estoque-sync-diario.js). Mantida num lugar so pra nao desalinhar.
//
// classe_produto "S" significa "Simples" (variacao de produto), NAO servico —
// so tratamos como servico quando, alem disso, nao tem codigo nem unidade.
function classificarProduto(prod) {
  if (prod.classe_produto === "S" && !prod.codigo && !prod.unidade) {
    return { elegivel: false, motivoExclusao: "servico" };
  }
  if ((prod.localizacao || "").toUpperCase().includes("REPRESENTA")) {
    return { elegivel: false, motivoExclusao: "representacao" };
  }
  return { elegivel: true, motivoExclusao: null };
}

module.exports = { classificarProduto };
