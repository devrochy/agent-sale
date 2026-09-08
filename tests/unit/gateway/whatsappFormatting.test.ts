import { describe, expect, it } from "vitest";
import { sanitizeForWhatsApp } from "../../../src/gateway/whatsappFormatting.js";

describe("sanitizeForWhatsApp", () => {
  it("convierte doble asterisco (negrita markdown estándar) a negrita de WhatsApp", () => {
    expect(sanitizeForWhatsApp("Este casco es **muy resistente**.")).toBe("Este casco es *muy resistente*.");
  });

  it("convierte doble guion bajo a negrita de WhatsApp", () => {
    expect(sanitizeForWhatsApp("Precio __especial__ hoy")).toBe("Precio *especial* hoy");
  });

  it("convierte múltiples negritas en el mismo texto", () => {
    expect(sanitizeForWhatsApp("**Casco** integral y **guantes** de cuero")).toBe(
      "*Casco* integral y *guantes* de cuero",
    );
  });

  it("convierte encabezados markdown a negrita de WhatsApp", () => {
    expect(sanitizeForWhatsApp("# Productos disponibles")).toBe("*Productos disponibles*");
    expect(sanitizeForWhatsApp("## Detalle del pedido")).toBe("*Detalle del pedido*");
  });

  it("convierte encabezados y negritas juntos en un texto de varias líneas", () => {
    const input = "# Resumen\nTu pedido de **2 cascos** quedó confirmado.";
    const expected = "*Resumen*\nTu pedido de *2 cascos* quedó confirmado.";
    expect(sanitizeForWhatsApp(input)).toBe(expected);
  });

  it("deja intacto un texto que ya usa el formato correcto de WhatsApp", () => {
    const texto = "*Casco Integral Thunder Road* — $380.000\n_Envío gratis_ en pedidos sobre $200.000";
    expect(sanitizeForWhatsApp(texto)).toBe(texto);
  });

  it("deja intacto un texto plano sin ningún formato", () => {
    const texto = "Hola, tu pedido FM-0001 fue confirmado.";
    expect(sanitizeForWhatsApp(texto)).toBe(texto);
  });

  it("no rompe un texto con un solo asterisco suelto (no es un par de negrita)", () => {
    expect(sanitizeForWhatsApp("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("devuelve el string vacío tal cual", () => {
    expect(sanitizeForWhatsApp("")).toBe("");
  });
});
