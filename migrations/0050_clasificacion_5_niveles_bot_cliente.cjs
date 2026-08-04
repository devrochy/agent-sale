// Fase 23 (ver docs/fase-23-crud-promociones-clasificacion-cliente/adrs/ADR-036-clasificacion-cliente-5-niveles-y-rediseno-leads.md):
// reemplaza la clasificación de 3 niveles de la Fase 17 (ADR-027) por 5
// niveles (nuevo/ocasional/frecuente/fiel/inactivo) y agrega un kill-switch
// de bot por cliente independiente del global (`settings.bot_paused`,
// migrations/0020).
//
// `customer_recurrente_min_pedidos` se renombra (no se agrega uno nuevo)
// porque es exactamente el mismo concepto con el nombre que trae la
// terminología de 5 niveles — RENAME preserva el valor ya configurado (o su
// default) en el singleton existente, un DROP+ADD lo hubiera perdido.
//
// `eligible_segments` de Fase 17 (migrations/0049) puede tener 'recurrente'
// ya sembrado — se migra el dato, no solo el código, para no perder
// silenciosamente la elegibilidad de una promoción ya creada durante el
// piloto.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE settings RENAME COLUMN customer_recurrente_min_pedidos TO customer_frecuente_min_pedidos;
    ALTER TABLE settings ADD COLUMN customer_frecuente_intervalo_max_dias integer NOT NULL DEFAULT 45;
    ALTER TABLE settings ADD COLUMN customer_inactivo_dias_sin_comprar integer NOT NULL DEFAULT 120;

    UPDATE promotions SET eligible_segments = array_replace(eligible_segments, 'recurrente', 'frecuente')
    WHERE eligible_segments IS NOT NULL AND 'recurrente' = ANY(eligible_segments);

    ALTER TABLE customers ADD COLUMN bot_paused boolean NOT NULL DEFAULT false;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE customers DROP COLUMN bot_paused;

    UPDATE promotions SET eligible_segments = array_replace(eligible_segments, 'frecuente', 'recurrente')
    WHERE eligible_segments IS NOT NULL AND 'frecuente' = ANY(eligible_segments);

    ALTER TABLE settings DROP COLUMN customer_inactivo_dias_sin_comprar;
    ALTER TABLE settings DROP COLUMN customer_frecuente_intervalo_max_dias;
    ALTER TABLE settings RENAME COLUMN customer_frecuente_min_pedidos TO customer_recurrente_min_pedidos;
  `);
};
