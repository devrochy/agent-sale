# Fase 0 — Descubrimiento y Validación de Negocio

Estado: **cerrada** (rama `feature/fase-0-descubrimiento`)

Referencia: [MASTER_PLAN.md](../MASTER_PLAN.md#fase-0--descubrimiento-y-validación-de-negocio)

---

## 1. PyME piloto

**Negocio:** ForMotos ([formotos.com](https://formotos.com/))
**Giro:** Retail de accesorios y repuestos de motocicletas.
**Canal de venta actual:** WhatsApp, 100% manual — un vendedor responde cada mensaje a mano, sin automatización ni bot.
**Inventario:** Más de 300 productos, llevado hoy en Google Sheets. La integración de datos debe diseñarse de forma flexible (no acoplada específicamente a Sheets), para poder migrar a otra fuente sin rediseñar el módulo de inventario.
**Promociones:**
- **Por temporada:** fin de año y "día de celebridad" (fechas puntuales de campaña), con % de descuento.
- **Por volumen:** tramos variables de unidades (ej. 10-20, 20-40), con beneficio de % de descuento o producto/servicio gratis.
**Pago y entrega:** aceptan transferencia, efectivo contraentrega y tarjeta; entregan a domicilio y también permiten recoger en tienda.
**Piloto confirmado:** sí — el dueño de ForMotos está de acuerdo en operar como negocio piloto.

**Baseline actual (antes del agente):**
| Indicador | Valor actual |
|---|---|
| Volumen de conversaciones | ~100 por semana |
| Tiempo de respuesta promedio | ~20 minutos |
| Ticket promedio por pedido | $100.000 COP |

---

## 2. Catálogo de ejemplo

| Producto | Precio (COP) |
|---|---|
| Casco | $300.000 |
| Guantes | $100.000 |
| Llanta | $250.000 |

> Muestra mínima para validar el modelo de datos de producto/precio en la Fase 1. El catálogo completo se levantará con el negocio antes de la Fase 5 (Catálogo e Inventario).

---

## 3. Casos de uso priorizados

Ordenados por frecuencia esperada en un negocio de repuestos/accesorios de moto vendiendo por WhatsApp:

1. **Consulta de disponibilidad y precio de un producto puntual**
   Ej: *"¿Tienen casco talla M?"* → el agente responde con precio, existencia y variantes disponibles.

2. **Cotización de un combo/kit**
   Ej: *"Necesito casco, guantes y una llanta"* → el agente genera una cotización con el total y aplica promoción por volumen si corresponde.

3. **Consulta o aplicación de promoción vigente**
   Ej: *"¿Tienen descuento en llantas este mes?"* → el agente identifica la promoción de temporada activa y la aplica a la cotización.

4. **Confirmación de pedido**
   Ej: cliente acepta la cotización → el agente crea el pedido y confirma método de entrega/pago (detalle a definir con el negocio).

5. **Consulta técnica o de compatibilidad → escalamiento a humano**
   Ej: *"¿Esta llanta le sirve a mi moto AKT 125?"* — si el agente no tiene certeza (compatibilidad técnica no está en catálogo estructurado), debe escalar a un asesor humano en vez de adivinar.

---

## 4. Criterios de éxito del MVP

| Métrica | Baseline actual (manual) | Objetivo del piloto | Cómo se mide |
|---|---|---|---|
| % de mensajes resueltos sin humano | 0% (100% manual hoy) | ≥ 60% en el piloto inicial | mensajes cerrados por el agente / total de conversaciones |
| Tiempo de respuesta promedio | ~20 minutos | < 30 segundos | timestamp de mensaje entrante vs. respuesta del agente |
| Pedidos cerrados por semana | baseline a medir en semana 1 del piloto (no registrado formalmente hoy) | igual o mayor al baseline manual | pedidos creados por el agente / total de pedidos del negocio en el período |
| Rentabilidad del piloto | — | costo operativo (Claude + infraestructura + BSP) por conversación debe ser bajo frente al ticket promedio de $100.000 COP | costo total del período / conversaciones atendidas, comparado contra ticket promedio |

Con ~100 conversaciones/semana como volumen base, el piloto debe demostrar que el costo operativo por conversación deja margen suficiente frente al ticket promedio de $100.000 COP para considerarse rentable — este cálculo se hace con datos reales de costo en la Fase 9 (Piloto Controlado).

---

## 5. Preguntas resueltas con el negocio

- [x] Sistema de inventario actual: Google Sheets (integración debe ser flexible a futuro).
- [x] Tamaño real del catálogo: más de 300 productos.
- [x] Reglas de promociones: por temporada (fin de año, día de celebridad) y por volumen (tramos variables, % descuento o producto/servicio gratis).
- [x] Volumen actual de mensajes: ~100 por semana.
- [x] Tiempo de respuesta manual actual: ~20 minutos.
- [x] Métodos de pago y entrega: transferencia, efectivo contraentrega, tarjeta; domicilio o recoger en tienda.
- [x] Ticket promedio de pedido: $100.000 COP.
- [x] Confirmación como piloto: sí, el dueño de ForMotos está de acuerdo.

**Pendiente menor para la Fase 1/5 (no bloquea el cierre de esta fase):** definir el porcentaje/beneficio exacto de cada tramo de promoción por volumen y la vigencia exacta de las promociones de temporada, para modelarlas como reglas estructuradas en el motor de promociones.

---

## 6. Definición de terminado de esta fase

- [x] Las 8 preguntas de la sección 5 están respondidas.
- [x] Los criterios de éxito de la sección 4 tienen baseline real y objetivo definido.
- [x] ForMotos confirma disposición a operar como piloto real (validado formalmente en Fase 9).

**Fase 0 completada.** Siguiente paso: Fase 1 — Arquitectura Técnica y Diseño de Datos.
