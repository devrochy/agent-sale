// Costo y tokens acumulados por conversación (ver ADR-017 y
// docs/fase-11-panel-admin-dashboard/analitica-costos.md): el costo/tokens
// reales por llamada ya viven en `llm_usage` (insert best-effort en
// src/orchestrator/loop.ts), pero hoy se recomputa al vuelo y las
// conversaciones sin uso LLM quedan en $0. Este backfill persiste el
// acumulado directamente en `conversations` (lecturas baratas en el panel:
// lista de Conversaciones y columna de costo de Leads) y siembra filas
// sintéticas en `llm_usage` para las conversaciones históricas sin datos,
// así la Analítica (costo del mes, tendencia, costo por resultado) también
// refleja esos costos — pedido explícito del usuario.
//
// Regla del backfill (pedido del usuario: "a las conversaciones actuales se
// le agregue un valor aleatorio real"): donde existe `llm_usage` REAL se usa
// la suma real; TODA conversación sin ningún uso registrado recibe valores
// sintéticos realistas. El costo se deriva de la cantidad de mensajes (y un
// piso mínimo para las vacías) con el precio de deepseek-chat, consistente
// con el entorno `env-default`.
//
// Nota: es un backfill ONE-TIME para datos existentes — instalaciones
// nuevas solo acumulan uso real desde loop.ts. Las filas sintéticas usan el
// mismo provider/model que las reales del entorno, así que no se distinguen;
// por eso el down solo baja las columnas, sin tocar llm_usage.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations
      ADD COLUMN costo_total_usd numeric(10,6) NOT NULL DEFAULT 0,
      ADD COLUMN tokens_entrada_total integer NOT NULL DEFAULT 0,
      ADD COLUMN tokens_salida_total integer NOT NULL DEFAULT 0;

    -- Filas sintéticas realistas para conversaciones sin uso LLM registrado:
    -- una llamada por cada ~2 mensajes, con un piso de 2-11 llamadas para que
    -- hasta las conversaciones vacías muestren un costo plausible. Tokens en
    -- el rango observado en llm_usage (~1000-15000 entrada, ~80-400 salida),
    -- precio deepseek-chat ($0.27/$1.10 por millón), y created_at dentro del
    -- ciclo de vida de la conversación para poblar los gráficos de tendencia.
    INSERT INTO llm_usage
      (conversation_id, provider, model, input_tokens, output_tokens, latency_ms, cost_usd, created_at)
    SELECT
      c.id,
      'env-default',
      'deepseek-chat',
      (1000 + floor(random() * 14000))::int AS input_tokens,
      (80 + floor(random() * 320))::int AS output_tokens,
      (300 + floor(random() * 2200))::int AS latency_ms,
      round(
        ((1000 + floor(random() * 14000)) / 1e6 * 0.27
       + (80 + floor(random() * 320)) / 1e6 * 1.10)::numeric, 6) AS cost_usd,
      c.started_at + random() * (now() - c.started_at) AS created_at
    FROM conversations c
    CROSS JOIN LATERAL (
      SELECT count(*) AS msgs FROM messages m WHERE m.conversation_id = c.id
    ) mc
    CROSS JOIN generate_series(
      1,
      least(greatest(2 + floor(random() * 10)::int, round(mc.msgs / 2.0)::int), 120)
    ) g
    WHERE NOT EXISTS (SELECT 1 FROM llm_usage u WHERE u.conversation_id = c.id);

    -- Acumulado por conversación = suma de llm_usage (reales + sintéticas) —
    -- un solo UPDATE cubre ambos casos.
    UPDATE conversations c SET
      costo_total_usd = u.costo,
      tokens_entrada_total = u.tin,
      tokens_salida_total = u.tout
    FROM (
      SELECT conversation_id,
             coalesce(sum(cost_usd), 0) AS costo,
             coalesce(sum(input_tokens), 0) AS tin,
             coalesce(sum(output_tokens), 0) AS tout
      FROM llm_usage
      GROUP BY conversation_id
    ) u
    WHERE u.conversation_id = c.id;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations
      DROP COLUMN costo_total_usd,
      DROP COLUMN tokens_entrada_total,
      DROP COLUMN tokens_salida_total;
  `);
};