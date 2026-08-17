import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSettingsRow } from "../../../../src/shared/db/settingsDirectory.js";
import { pool as appPool } from "../../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

// `settings` es singleton: este archivo tiene que dejarla exactamente como
// la encontró o rompe a todo el resto de la suite (vitest corre con
// fileParallelism:false, así que basta con restaurar en afterAll). Se
// guarda la fila entera —no solo las columnas que interesan— y se
// reinserta columna por columna a partir de sus propias claves.
let filaOriginal: Record<string, unknown> | null = null;

async function contarFilas(): Promise<number> {
  const { rows } = await adminPool.query<{ n: string }>("SELECT count(*)::text AS n FROM settings");
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  const { rows } = await adminPool.query("SELECT * FROM settings LIMIT 1");
  filaOriginal = rows[0] ?? null;
  await adminPool.query("DELETE FROM settings");
});

afterAll(async () => {
  await adminPool.query("DELETE FROM settings");
  if (filaOriginal) {
    const columnas = Object.keys(filaOriginal);
    const marcadores = columnas.map((_, i) => `$${i + 1}`).join(", ");
    await adminPool.query(
      `INSERT INTO settings (${columnas.map((c) => `"${c}"`).join(", ")}) VALUES (${marcadores})`,
      columnas.map((c) => filaOriginal![c]),
    );
  }
  await adminPool.end();
  await appPool.end();
});

describe("ensureSettingsRow", () => {
  it("siembra la fila cuando la base viene vacía", async () => {
    expect(await contarFilas()).toBe(0);

    await ensureSettingsRow();

    const { rows } = await adminPool.query<{ name: string }>("SELECT name FROM settings");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Mi negocio");
  });

  it("no duplica la fila si ya existe", async () => {
    // Arranques sucesivos del proceso: la semilla corre en cada uno.
    await ensureSettingsRow();
    await ensureSettingsRow();

    expect(await contarFilas()).toBe(1);
  });

  it("respeta el nombre que ya tenga la instalación", async () => {
    await adminPool.query("UPDATE settings SET name = $1", ["ForMotos"]);

    await ensureSettingsRow();

    const { rows } = await adminPool.query<{ name: string }>("SELECT name FROM settings");
    expect(rows[0]!.name).toBe("ForMotos");
  });
});
