import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformRow, transformAndFilter } from "../src/transformProfile.js";

describe("transformRow — fallback para vetor denso", () => {
  it("preenche descricao a partir de modelo_negocio quando ofertas estão vazias", () => {
    const row = {
      cnpj: "12345678000199",
      full_profile: {
        identidade: { nome_empresa: "ACME Ltda", descricao: "" },
        ofertas: { produtos: "", servicos: "" },
        classificacao: {
          modelo_negocio: "Distribuidor B2B",
          publico_alvo: "",
          industria: "Energia",
        },
        reputacao: { lista_clientes: "" },
      },
    };
    const item = transformRow(row);
    assert.ok(item.filledVectorKeys.includes("descricao"), "deve gerar ao menos um vetor denso");
    assert.ok(item.descricao.includes("Distribuidor B2B"));
    assert.equal(item.payload.descricao, item.descricao);
  });

  it("transformAndFilter inclui linha só com modelo_negocio", () => {
    const rows = [
      {
        cnpj: "111",
        full_profile: {
          identidade: {},
          ofertas: {},
          classificacao: { modelo_negocio: "Fabricante" },
          reputacao: {},
        },
      },
    ];
    const { items, after_transform } = transformAndFilter(rows);
    assert.equal(after_transform, 1);
    assert.ok(items[0].filledVectorKeys.length >= 1);
  });
});
