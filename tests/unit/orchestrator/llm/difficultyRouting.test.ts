import { describe, expect, it } from "vitest";
import {
  classifyDifficulty,
  pickModelByDifficulty,
} from "../../../../src/orchestrator/llm/difficultyRouting.js";

describe("classifyDifficulty", () => {
  it("clasifica un mensaje corto sin problemas previos como económico", () => {
    expect(
      classifyDifficulty({ latestCustomerText: "Hola, tienen cascos?", turnosSinResolver: 0 }),
    ).toBe("economico");
  });

  it("clasifica un mensaje largo sin señales de dificultad como equilibrado (no económico por default)", () => {
    const text =
      "Buenas, estoy buscando un casco integral para andar en carretera los fines de semana, algo cómodo";
    expect(classifyDifficulty({ latestCustomerText: text, turnosSinResolver: 0 })).toBe(
      "equilibrado",
    );
  });

  it("sube a máximo si ya hubo turnos sin resolver, aunque el mensaje sea corto", () => {
    expect(classifyDifficulty({ latestCustomerText: "y ahora?", turnosSinResolver: 2 })).toBe(
      "maximo",
    );
  });

  it("sube a máximo ante keywords de comparación/compatibilidad técnica", () => {
    expect(
      classifyDifficulty({
        latestCustomerText: "es compatible con mi moto Honda CB500?",
        turnosSinResolver: 0,
      }),
    ).toBe("maximo");
    expect(
      classifyDifficulty({
        latestCustomerText: "cuál es mejor, el casco A o el B?",
        turnosSinResolver: 0,
      }),
    ).toBe("maximo");
  });

  it("texto vacío no cuenta como trivial (económico) — cae en equilibrado", () => {
    expect(classifyDifficulty({ latestCustomerText: "", turnosSinResolver: 0 })).toBe(
      "equilibrado",
    );
  });
});

describe("pickModelByDifficulty", () => {
  const tres = [
    { id: "barato", label: "" },
    { id: "medio", label: "" },
    { id: "caro", label: "" },
  ];

  it("con 3 modelos, elige por índice: 0/medio/último", () => {
    expect(pickModelByDifficulty(tres, "economico")).toBe("barato");
    expect(pickModelByDifficulty(tres, "equilibrado")).toBe("medio");
    expect(pickModelByDifficulty(tres, "maximo")).toBe("caro");
  });

  it("con 1 modelo, siempre el mismo (no-op) sin importar la dificultad", () => {
    const uno = [{ id: "unico", label: "" }];
    expect(pickModelByDifficulty(uno, "economico")).toBe("unico");
    expect(pickModelByDifficulty(uno, "equilibrado")).toBe("unico");
    expect(pickModelByDifficulty(uno, "maximo")).toBe("unico");
  });

  it("con 2 modelos, equilibrado y máximo colapsan al índice 1", () => {
    const dos = [
      { id: "barato", label: "" },
      { id: "caro", label: "" },
    ];
    expect(pickModelByDifficulty(dos, "economico")).toBe("barato");
    expect(pickModelByDifficulty(dos, "equilibrado")).toBe("caro");
    expect(pickModelByDifficulty(dos, "maximo")).toBe("caro");
  });

  it("lanza si el catálogo no tiene modelos", () => {
    expect(() => pickModelByDifficulty([], "equilibrado")).toThrow();
  });
});
