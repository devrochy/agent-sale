import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmarImportacionCsv, previsualizarImportacionCsv } from "../../../src/admin/adminPanel.js";
import { pool as appPool } from "../../../src/shared/db/pool.js";

const { Pool } = pg;
const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

let allyId: string;
let categoryId: string;
let categoryId2: string;
const productIds: string[] = [];

beforeAll(async () => {
  const ally = await adminPool.query<{ id: string }>(
    `INSERT INTO allies (name) VALUES ('Aliado Test Import CSV') RETURNING id`,
  );
  allyId = ally.rows[0]!.id;

  const category = await adminPool.query<{ id: string }>(
    `INSERT INTO product_categories (name) VALUES ('Categoría Test Import CSV') RETURNING id`,
  );
  categoryId = category.rows[0]!.id;
  const category2 = await adminPool.query<{ id: string }>(
    `INSERT INTO product_categories (name) VALUES ('Categoría Test Import CSV 2') RETURNING id`,
  );
  categoryId2 = category2.rows[0]!.id;

  // Variante preexistente para probar la rama de "actualizar" (no crear).
  // Con descripción/imagen ya guardadas, para probar que la previsualización
  // las muestre en modo lectura (nunca se reasignan vía carga masiva).
  const product = await adminPool.query<{ id: string }>(
    `INSERT INTO products (ally_id, name, description, image_url)
     VALUES ($1, 'Producto CSV preexistente', 'Descripción ya guardada', 'http://existente.test/img.png')
     RETURNING id`,
    [allyId],
  );
  productIds.push(product.rows[0]!.id);
  const variant = await adminPool.query<{ id: string }>(
    `INSERT INTO product_variants (product_id, sku, price) VALUES ($1, 'CSV-EXISTENTE', 10000) RETURNING id`,
    [product.rows[0]!.id],
  );
  await adminPool.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, 2)`, [
    variant.rows[0]!.id,
  ]);
});

afterAll(async () => {
  const nuevo = await adminPool.query<{ id: string }>(
    `SELECT product_id AS id FROM product_variants WHERE sku IN ('CSV-NUEVO-1', 'CSV-VARIANTE-S', 'CSV-VARIANTE-M')`,
  );
  for (const row of [...productIds, ...nuevo.rows.map((r) => r.id)]) {
    await adminPool.query(
      `DELETE FROM inventory WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`,
      [row],
    );
    await adminPool.query(`DELETE FROM product_variants WHERE product_id = $1`, [row]);
    await adminPool.query(`DELETE FROM products WHERE id = $1`, [row]);
  }
  await adminPool.query(`DELETE FROM allies WHERE id = $1`, [allyId]);
  await adminPool.query(`DELETE FROM product_categories WHERE id IN ($1, $2)`, [categoryId, categoryId2]);
  await adminPool.end();
  await appPool.end();
});

describe("previsualizarImportacionCsv", () => {
  it("clasifica cada fila en crear/actualizar/error sin escribir nada en la base", async () => {
    const csv = [
      "sku,name,price,stock,talla,color,description,imageUrl",
      "CSV-EXISTENTE,Nombre ignorado,15000,9,,,Descripción ignorada,http://ignorada.test/img.png",
      "CSV-NUEVO-1,Producto CSV nuevo,30000,4,M,rojo,Descripción del nuevo,http://ejemplo.test/img.png",
      ",Fila sin sku,1000,1,,,,",
    ].join("\n");

    const resultado = await previsualizarImportacionCsv(csv);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    const [existente, nuevo, sinSku] = resultado.rows;
    expect(existente!.kind).toBe("actualizar");
    expect(existente!.existingPrice).toBe(10000);
    expect(existente!.existingStock).toBe(2);
    // Actualizar nunca toca descripción/imagen de un producto existente vía carga masiva,
    // pero la previsualización sí debe traer la existente para mostrarla en modo lectura.
    expect(existente!.description).toBe("");
    expect(existente!.imageUrl).toBe("");
    expect(existente!.existingDescription).toBe("Descripción ya guardada");
    expect(existente!.existingImageUrl).toBe("http://existente.test/img.png");
    expect(nuevo!.kind).toBe("crear");
    expect(nuevo!.description).toBe("Descripción del nuevo");
    expect(nuevo!.imageUrl).toBe("http://ejemplo.test/img.png");
    expect(sinSku!.kind).toBe("error");

    // No escribió nada en la base — la previsualización solo clasifica, no confirma.
    const sinTocar = await adminPool.query<{ price: string }>(
      `SELECT price FROM product_variants WHERE sku = 'CSV-EXISTENTE'`,
    );
    expect(Number(sinTocar.rows[0]!.price)).toBe(10000);
  });

  it("devuelve error si el archivo no tiene filas", async () => {
    const resultado = await previsualizarImportacionCsv("sku,name,price,stock");
    expect(resultado.ok).toBe(false);
  });
});

describe("confirmarImportacionCsv", () => {
  it("actualiza precio/stock de un SKU existente y crea uno nuevo, sin abortar por una fila con error", async () => {
    const resultado = await confirmarImportacionCsv(allyId, [
      {
        sku: "CSV-EXISTENTE",
        name: "Nombre ignorado",
        price: "15000",
        stock: "9",
        talla: "",
        color: "",
        categoryId: "",
        description: "",
        imageUrl: "",
      },
      {
        sku: "CSV-NUEVO-1",
        name: "Producto CSV nuevo",
        price: "30000",
        stock: "4",
        talla: "M",
        color: "rojo",
        categoryId,
        description: "Descripción del nuevo",
        imageUrl: "http://ejemplo.test/img.png",
      },
      {
        sku: "CSV-SIN-PRECIO",
        name: "Producto sin precio",
        price: "no-es-un-numero",
        stock: "4",
        talla: "",
        color: "",
        categoryId: "",
        description: "",
        imageUrl: "",
      },
    ]);

    expect(resultado.creados).toBe(1);
    expect(resultado.actualizados).toBe(1);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0]!.message).toContain("CSV-SIN-PRECIO");

    const existente = await adminPool.query<{ price: string; name: string; description: string; image_url: string }>(
      `SELECT pv.price, p.name, p.description, p.image_url FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.sku = 'CSV-EXISTENTE'`,
    );
    expect(Number(existente.rows[0]!.price)).toBe(15000);
    // El SKU existente no cambia de nombre/descripción/imagen por la carga masiva (solo precio/stock).
    expect(existente.rows[0]!.name).toBe("Producto CSV preexistente");
    expect(existente.rows[0]!.description).toBe("Descripción ya guardada");
    expect(existente.rows[0]!.image_url).toBe("http://existente.test/img.png");

    const stockExistente = await adminPool.query<{ stock_quantity: number }>(
      `SELECT i.stock_quantity FROM inventory i JOIN product_variants pv ON pv.id = i.variant_id WHERE pv.sku = 'CSV-EXISTENTE'`,
    );
    expect(stockExistente.rows[0]!.stock_quantity).toBe(9);

    const nuevo = await adminPool.query<{
      attributes: Record<string, unknown>;
      ally_id: string;
      category_id: string;
      description: string;
      image_url: string;
    }>(
      `SELECT pv.attributes, p.ally_id, p.category_id, p.description, p.image_url FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.sku = 'CSV-NUEVO-1'`,
    );
    expect(nuevo.rows[0]!.attributes).toEqual({ talla: "M", color: "rojo" });
    expect(nuevo.rows[0]!.ally_id).toBe(allyId);
    expect(nuevo.rows[0]!.category_id).toBe(categoryId);
    expect(nuevo.rows[0]!.description).toBe("Descripción del nuevo");
    expect(nuevo.rows[0]!.image_url).toBe("http://ejemplo.test/img.png");
  });

  it("agrupa varias filas nuevas con el mismo nombre como variantes de un solo producto, usando la categoría de la primera fila", async () => {
    const resultado = await confirmarImportacionCsv(allyId, [
      {
        sku: "CSV-VARIANTE-S",
        name: "Producto CSV con variantes",
        price: "20000",
        stock: "2",
        talla: "S",
        color: "azul",
        categoryId,
        description: "Descripción de la primera fila",
        imageUrl: "http://ejemplo.test/primera.png",
      },
      {
        sku: "CSV-VARIANTE-M",
        name: "Producto CSV con variantes",
        price: "20000",
        stock: "3",
        talla: "M",
        color: "azul",
        categoryId: categoryId2,
        description: "Descripción de la segunda fila (se ignora)",
        imageUrl: "http://ejemplo.test/segunda.png",
      },
    ]);

    expect(resultado.creados).toBe(2);
    expect(resultado.errores).toHaveLength(0);

    const producto = await adminPool.query<{
      id: string;
      category_id: string;
      description: string;
      image_url: string;
      variant_count: string;
    }>(
      `SELECT p.id, p.category_id, p.description, p.image_url, COUNT(pv.id) AS variant_count
       FROM products p JOIN product_variants pv ON pv.product_id = p.id
       WHERE p.name = 'Producto CSV con variantes'
       GROUP BY p.id`,
    );
    expect(producto.rows).toHaveLength(1);
    expect(Number(producto.rows[0]!.variant_count)).toBe(2);
    expect(producto.rows[0]!.category_id).toBe(categoryId);
    // La descripción/imagen del producto son las de la primera fila del grupo, igual que la categoría.
    expect(producto.rows[0]!.description).toBe("Descripción de la primera fila");
    expect(producto.rows[0]!.image_url).toBe("http://ejemplo.test/primera.png");
  });
});
