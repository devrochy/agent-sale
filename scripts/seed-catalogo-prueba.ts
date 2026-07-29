/**
 * Herramienta manual (no forma parte de la app ni de los tests
 * automatizados): siembra un catálogo de prueba de 100 productos de una
 * tienda de repuestos/accesorios de moto (ForMotos), repartidos en varias
 * categorías con varios productos cada una — para poder probar en local
 * el panel admin (src/admin/adminPanel.ts), la tool consultar_inventario
 * con description/image_url, y el envío de imagen por WhatsApp, antes de
 * pasar a la Fase 9.
 *
 * Reutiliza el mismo tenant de prueba que seed-manual-test.ts
 * (whatsapp_number = 'whatsapp:+573000000000') para no duplicar tenants
 * de prueba en el flujo local.
 *
 * Uso:
 *   npm run seed:catalogo-prueba
 */
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const TEST_TENANT_WHATSAPP_NUMBER = "whatsapp:+573000000000";

interface ProductoPrueba {
  sku: string;
  name: string;
  category: string;
  price: number;
  description: string;
  stock: number;
}

// 100 productos en 16 categorías, varios por categoría a propósito (para
// poder probar filtros/búsquedas por categoría y por nombre en local).
const PRODUCTOS: ProductoPrueba[] = [
  // Cascos
  { sku: "CAS-001", name: "Casco Integral Thunder Road", category: "cascos", price: 380000, description: "Casco integral con visor antirayas y ventilación regulable, ideal para carretera.", stock: 12 },
  { sku: "CAS-002", name: "Casco Integral Storm GT", category: "cascos", price: 420000, description: "Casco integral de fibra de vidrio, doble densidad de espuma para mayor absorción de impacto.", stock: 8 },
  { sku: "CAS-003", name: "Casco Abierto Urban Rider", category: "cascos", price: 210000, description: "Casco abierto liviano para uso urbano, con visor solar interno.", stock: 15 },
  { sku: "CAS-004", name: "Casco Modular Cross Tech", category: "cascos", price: 450000, description: "Casco modular con mentonera abatible, permite usarlo integral o abierto.", stock: 0 },
  { sku: "CAS-005", name: "Casco Infantil SafeKid", category: "cascos", price: 150000, description: "Casco integral talla infantil, colores llamativos y correa de seguridad reforzada.", stock: 10 },
  { sku: "CAS-006", name: "Casco Integral Racing Pro", category: "cascos", price: 480000, description: "Casco de competición homologado, aerodinámica optimizada para alta velocidad.", stock: 5 },
  { sku: "CAS-007", name: "Casco Abierto Vintage Cafe", category: "cascos", price: 230000, description: "Casco estilo retro para motos café racer, visor incluido.", stock: 9 },
  { sku: "CAS-008", name: "Casco Cross Enduro X", category: "cascos", price: 260000, description: "Casco para motocross con visera larga y ventilación frontal amplia.", stock: 7 },

  // Guantes
  { sku: "GUA-001", name: "Guantes de Cuero Touring", category: "guantes", price: 95000, description: "Guantes de cuero genuino con protección en nudillos, para viajes largos.", stock: 20 },
  { sku: "GUA-002", name: "Guantes Racing con Protección", category: "guantes", price: 120000, description: "Guantes con protección rígida en nudillos y palma antideslizante para uso deportivo.", stock: 14 },
  { sku: "GUA-003", name: "Guantes Urbanos Táctiles", category: "guantes", price: 55000, description: "Guantes livianos compatibles con pantalla táctil, uso diario en ciudad.", stock: 25 },
  { sku: "GUA-004", name: "Guantes Impermeables Invierno", category: "guantes", price: 85000, description: "Guantes forrados e impermeables para clima frío y lluvia.", stock: 0 },
  { sku: "GUA-005", name: "Guantes Cross con Nudillera", category: "guantes", price: 70000, description: "Guantes de motocross con nudillera de protección y agarre reforzado.", stock: 11 },
  { sku: "GUA-006", name: "Guantes de Malla Verano", category: "guantes", price: 45000, description: "Guantes transpirables de malla para clima cálido.", stock: 18 },
  { sku: "GUA-007", name: "Guantes Mujer Comfort Fit", category: "guantes", price: 60000, description: "Guantes diseñados para mano femenina, ajuste ergonómico y protección básica.", stock: 13 },

  // Chaquetas
  { sku: "CHA-001", name: "Chaqueta Textil Touring", category: "chaquetas", price: 320000, description: "Chaqueta textil impermeable con protecciones removibles en hombros y codos.", stock: 9 },
  { sku: "CHA-002", name: "Chaqueta de Cuero Classic", category: "chaquetas", price: 480000, description: "Chaqueta de cuero genuino estilo clásico, forro térmico desmontable.", stock: 6 },
  { sku: "CHA-003", name: "Chaqueta Racing con Protecciones", category: "chaquetas", price: 550000, description: "Chaqueta deportiva con protecciones CE en espalda, hombros y codos.", stock: 4 },
  { sku: "CHA-004", name: "Chaqueta Impermeable All Weather", category: "chaquetas", price: 280000, description: "Chaqueta todo clima con membrana impermeable y forro térmico.", stock: 0 },
  { sku: "CHA-005", name: "Chaqueta Mesh Verano", category: "chaquetas", price: 190000, description: "Chaqueta de malla transpirable con protecciones básicas, ideal para calor.", stock: 12 },
  { sku: "CHA-006", name: "Chaleco Reflectivo Seguridad", category: "chaquetas", price: 35000, description: "Chaleco reflectivo de alta visibilidad para conducción nocturna.", stock: 30 },
  { sku: "CHA-007", name: "Chaqueta Térmica Invierno", category: "chaquetas", price: 260000, description: "Chaqueta térmica acolchada para bajas temperaturas.", stock: 8 },

  // Llantas y neumáticos
  { sku: "LLA-001", name: "Llanta Delantera Sport 110/70-17", category: "llantas", price: 280000, description: "Llanta deportiva delantera, buen agarre en seco y mojado.", stock: 10 },
  { sku: "LLA-002", name: "Llanta Trasera Sport 140/70-17", category: "llantas", price: 320000, description: "Llanta deportiva trasera de alto rendimiento.", stock: 10 },
  { sku: "LLA-003", name: "Llanta Todo Terreno 90/90-19", category: "llantas", price: 260000, description: "Llanta mixta para asfalto y trocha, taco resistente.", stock: 7 },
  { sku: "LLA-004", name: "Llanta Urbana 80/100-18", category: "llantas", price: 190000, description: "Llanta económica para uso urbano diario.", stock: 15 },
  { sku: "LLA-005", name: "Llanta Touring 120/70-17", category: "llantas", price: 300000, description: "Llanta de larga duración pensada para viajes de carretera.", stock: 0 },
  { sku: "LLA-006", name: "Cámara de Aire Reforzada", category: "llantas", price: 35000, description: "Cámara de aire de caucho reforzado, varias medidas disponibles.", stock: 40 },
  { sku: "LLA-007", name: "Llanta Scooter 120/70-12", category: "llantas", price: 175000, description: "Llanta para scooter con buen agarre urbano.", stock: 9 },

  // Aceites y lubricantes
  { sku: "ACE-001", name: "Aceite Sintético 10W-40 1L", category: "aceites", price: 58000, description: "Aceite 100% sintético para motor 4 tiempos, alta protección térmica.", stock: 35 },
  { sku: "ACE-002", name: "Aceite Semisintético 20W-50 1L", category: "aceites", price: 42000, description: "Aceite semisintético de uso general para motos de trabajo diario.", stock: 40 },
  { sku: "ACE-003", name: "Aceite Mineral 20W-50 1L", category: "aceites", price: 28000, description: "Aceite mineral económico para motores de baja exigencia.", stock: 50 },
  { sku: "ACE-004", name: "Lubricante de Cadena Spray", category: "aceites", price: 25000, description: "Lubricante en spray para cadena, resistente al agua.", stock: 45 },
  { sku: "ACE-005", name: "Aceite de Horquilla 10W", category: "aceites", price: 32000, description: "Aceite específico para suspensión delantera.", stock: 0 },
  { sku: "ACE-006", name: "Grasa para Rodamientos", category: "aceites", price: 18000, description: "Grasa multipropósito para rodamientos y bujes.", stock: 22 },
  { sku: "ACE-007", name: "Aditivo Limpiador de Inyectores", category: "aceites", price: 30000, description: "Aditivo para limpiar inyectores y mejorar el rendimiento del motor.", stock: 17 },

  // Filtros
  { sku: "FIL-001", name: "Filtro de Aceite Universal", category: "filtros", price: 22000, description: "Filtro de aceite compatible con la mayoría de motores 150-250cc.", stock: 30 },
  { sku: "FIL-002", name: "Filtro de Aire Deportivo", category: "filtros", price: 38000, description: "Filtro de aire de alto flujo lavable y reutilizable.", stock: 20 },
  { sku: "FIL-003", name: "Filtro de Aire Original", category: "filtros", price: 25000, description: "Filtro de aire de repuesto según especificación de fábrica.", stock: 25 },
  { sku: "FIL-004", name: "Filtro de Combustible", category: "filtros", price: 15000, description: "Filtro de combustible en línea, evita impurezas en el sistema de inyección.", stock: 0 },
  { sku: "FIL-005", name: "Filtro de Aire de Alto Flujo", category: "filtros", price: 45000, description: "Filtro deportivo de alto flujo para mayor potencia.", stock: 12 },
  { sku: "FIL-006", name: "Filtro de Aceite Racing", category: "filtros", price: 28000, description: "Filtro de aceite de alto rendimiento para uso deportivo.", stock: 14 },

  // Frenos
  { sku: "FRE-001", name: "Pastillas de Freno Delanteras Cerámicas", category: "frenos", price: 65000, description: "Pastillas cerámicas de alto rendimiento y baja generación de polvo.", stock: 18 },
  { sku: "FRE-002", name: "Pastillas de Freno Traseras Orgánicas", category: "frenos", price: 45000, description: "Pastillas orgánicas de frenado suave para uso diario.", stock: 20 },
  { sku: "FRE-003", name: "Disco de Freno Delantero Flotante", category: "frenos", price: 180000, description: "Disco flotante de alto rendimiento, mejor disipación de calor.", stock: 6 },
  { sku: "FRE-004", name: "Disco de Freno Trasero", category: "frenos", price: 150000, description: "Disco de freno trasero de repuesto original.", stock: 0 },
  { sku: "FRE-005", name: "Líquido de Frenos DOT 4", category: "frenos", price: 22000, description: "Líquido de frenos DOT 4 para sistemas hidráulicos.", stock: 35 },
  { sku: "FRE-006", name: "Kit de Mangueras de Freno Trenzadas", category: "frenos", price: 130000, description: "Mangueras trenzadas de acero para mejor tacto de frenado.", stock: 8 },
  { sku: "FRE-007", name: "Bomba de Freno Trasera", category: "frenos", price: 95000, description: "Bomba de freno trasera de repuesto.", stock: 5 },

  // Cadenas y kits de arrastre
  { sku: "CAD-001", name: "Kit de Arrastre Completo 428H", category: "cadenas", price: 220000, description: "Kit completo (cadena, piñón, corona) para motos de 150-200cc.", stock: 10 },
  { sku: "CAD-002", name: "Cadena de Transmisión 520", category: "cadenas", price: 130000, description: "Cadena reforzada 520 para motos deportivas.", stock: 12 },
  { sku: "CAD-003", name: "Piñón Delantero", category: "cadenas", price: 40000, description: "Piñón delantero de acero de alta resistencia.", stock: 0 },
  { sku: "CAD-004", name: "Corona Trasera", category: "cadenas", price: 90000, description: "Corona trasera de aluminio liviano.", stock: 9 },
  { sku: "CAD-005", name: "Kit de Arrastre Reforzado Racing", category: "cadenas", price: 320000, description: "Kit de arrastre reforzado para uso deportivo o de competición.", stock: 4 },
  { sku: "CAD-006", name: "Tensor de Cadena Ajustable", category: "cadenas", price: 55000, description: "Tensor de cadena ajustable para mantener la tensión correcta.", stock: 15 },

  // Baterías
  { sku: "BAT-001", name: "Batería Gel 12V 9Ah", category: "baterias", price: 220000, description: "Batería de gel libre de mantenimiento, mayor vida útil.", stock: 14 },
  { sku: "BAT-002", name: "Batería de Litio Ultraligera", category: "baterias", price: 380000, description: "Batería de litio de bajo peso y arranque instantáneo.", stock: 5 },
  { sku: "BAT-003", name: "Batería Convencional 12V 5Ah", category: "baterias", price: 120000, description: "Batería de plomo-ácido convencional, requiere mantenimiento.", stock: 0 },
  { sku: "BAT-004", name: "Cargador de Batería Inteligente", category: "baterias", price: 85000, description: "Cargador inteligente con corte automático de carga.", stock: 18 },
  { sku: "BAT-005", name: "Batería AGM 12V 12Ah", category: "baterias", price: 260000, description: "Batería AGM sellada de alta durabilidad.", stock: 7 },

  // Luces y faros
  { sku: "LUZ-001", name: "Faro Delantero LED", category: "luces", price: 150000, description: "Faro delantero LED de alta luminosidad y bajo consumo.", stock: 10 },
  { sku: "LUZ-002", name: "Kit de Luces LED H4", category: "luces", price: 90000, description: "Kit de bombillas LED H4 plug and play.", stock: 20 },
  { sku: "LUZ-003", name: "Direccionales LED Ahumadas", category: "luces", price: 45000, description: "Par de direccionales LED con lente ahumado.", stock: 25 },
  { sku: "LUZ-004", name: "Luz Trasera LED con Freno", category: "luces", price: 55000, description: "Luz trasera LED integrada con función de freno.", stock: 0 },
  { sku: "LUZ-005", name: "Luces Auxiliares Neblineras", category: "luces", price: 110000, description: "Par de luces auxiliares para neblina y baja visibilidad.", stock: 8 },
  { sku: "LUZ-006", name: "Luz LED para Placa", category: "luces", price: 20000, description: "Luz LED pequeña para iluminación de placa.", stock: 30 },

  // Espejos
  { sku: "ESP-001", name: "Espejos Retrovisores Deportivos", category: "espejos", price: 65000, description: "Par de espejos deportivos de perfil aerodinámico.", stock: 16 },
  { sku: "ESP-002", name: "Espejos Retrovisores Clásicos", category: "espejos", price: 55000, description: "Par de espejos redondos estilo clásico.", stock: 14 },
  { sku: "ESP-003", name: "Espejos Convexos Antivibración", category: "espejos", price: 70000, description: "Espejos convexos que reducen el punto ciego y la vibración.", stock: 0 },
  { sku: "ESP-004", name: "Espejo Retrovisor Universal Cromado", category: "espejos", price: 35000, description: "Espejo universal cromado, encaja en la mayoría de modelos.", stock: 22 },
  { sku: "ESP-005", name: "Espejos Plegables Racing", category: "espejos", price: 90000, description: "Espejos plegables de bajo perfil para uso deportivo.", stock: 9 },

  // Escapes
  { sku: "ESC-001", name: "Escape Deportivo Slip-On", category: "escapes", price: 480000, description: "Escape deportivo de instalación simple, mejora sonido y peso.", stock: 6 },
  { sku: "ESC-002", name: "Escape Completo Racing", category: "escapes", price: 950000, description: "Sistema de escape completo de alto rendimiento para competición.", stock: 2 },
  { sku: "ESC-003", name: "Silenciador Universal", category: "escapes", price: 280000, description: "Silenciador universal adaptable a varios modelos.", stock: 8 },
  { sku: "ESC-004", name: "Protector de Escape Carbono", category: "escapes", price: 95000, description: "Protector térmico de fibra de carbono para el escape.", stock: 0 },
  { sku: "ESC-005", name: "Escape Megáfono Clásico", category: "escapes", price: 320000, description: "Escape estilo megáfono para motos clásicas y café racer.", stock: 5 },
  { sku: "ESC-006", name: "Empaque de Escape Universal", category: "escapes", price: 12000, description: "Empaque de repuesto para unión del escape al motor.", stock: 40 },

  // Accesorios
  { sku: "ACC-001", name: "Maleta Lateral Rígida", category: "accesorios", price: 420000, description: "Par de maletas laterales rígidas resistentes al agua.", stock: 5 },
  { sku: "ACC-002", name: "Baúl Trasero 40L", category: "accesorios", price: 250000, description: "Baúl trasero de 40 litros con respaldo acolchado.", stock: 9 },
  { sku: "ACC-003", name: "Cubre Asiento Impermeable", category: "accesorios", price: 40000, description: "Cubre asiento impermeable universal.", stock: 25 },
  { sku: "ACC-004", name: "Soporte para Celular", category: "accesorios", price: 35000, description: "Soporte ajustable para celular con agarre antivibración.", stock: 0 },
  { sku: "ACC-005", name: "Alarma Antirrobo con Sensor", category: "accesorios", price: 130000, description: "Alarma con sensor de movimiento y control remoto.", stock: 12 },
  { sku: "ACC-006", name: "Cubierta para Moto Impermeable", category: "accesorios", price: 60000, description: "Cubierta impermeable con protección UV.", stock: 20 },
  { sku: "ACC-007", name: "Portaequipaje Trasero", category: "accesorios", price: 75000, description: "Portaequipaje trasero de acero para carga adicional.", stock: 10 },
  { sku: "ACC-008", name: "Candado de Disco con Alarma", category: "accesorios", price: 90000, description: "Candado de disco con alarma sonora antirrobo.", stock: 14 },

  // Herramientas
  { sku: "HER-001", name: "Kit de Herramientas Básico", category: "herramientas", price: 85000, description: "Kit básico de herramientas para mantenimiento en casa.", stock: 16 },
  { sku: "HER-002", name: "Llave de Cruz para Moto", category: "herramientas", price: 30000, description: "Llave de cruz multipropósito para tuercas y pernos.", stock: 20 },
  { sku: "HER-003", name: "Compresor de Aire Portátil", category: "herramientas", price: 180000, description: "Compresor portátil 12V para inflar llantas.", stock: 0 },
  { sku: "HER-004", name: "Multímetro Digital", category: "herramientas", price: 65000, description: "Multímetro digital para diagnóstico eléctrico básico.", stock: 11 },
  { sku: "HER-005", name: "Elevador Hidráulico para Moto", category: "herramientas", price: 450000, description: "Elevador hidráulico para mantenimiento y cambio de llantas.", stock: 3 },

  // Amortiguadores y suspensión
  { sku: "AMO-001", name: "Amortiguador Trasero Ajustable", category: "amortiguadores", price: 320000, description: "Amortiguador trasero con ajuste de precarga.", stock: 7 },
  { sku: "AMO-002", name: "Kit de Amortiguadores Delanteros", category: "amortiguadores", price: 280000, description: "Par de amortiguadores delanteros de repuesto.", stock: 6 },
  { sku: "AMO-003", name: "Resortes de Suspensión Progresivos", category: "amortiguadores", price: 150000, description: "Resortes progresivos para mejorar la respuesta de la suspensión.", stock: 0 },
  { sku: "AMO-004", name: "Amortiguador de Dirección", category: "amortiguadores", price: 260000, description: "Amortiguador de dirección para mayor estabilidad en carretera.", stock: 4 },
  { sku: "AMO-005", name: "Bujes de Suspensión Poliuretano", category: "amortiguadores", price: 60000, description: "Bujes de poliuretano de alta durabilidad.", stock: 15 },
  { sku: "AMO-006", name: "Kit de Retenes de Horquilla", category: "amortiguadores", price: 45000, description: "Kit de retenes para sellar la horquilla delantera.", stock: 18 },

  // Bujías y eléctrico
  { sku: "BUJ-001", name: "Bujía de Iridio", category: "electrico", price: 45000, description: "Bujía de iridio de larga duración y mejor encendido.", stock: 24 },
  { sku: "BUJ-002", name: "Bujía Estándar", category: "electrico", price: 12000, description: "Bujía estándar de níquel para uso general.", stock: 40 },
  { sku: "BUJ-003", name: "Bobina de Encendido", category: "electrico", price: 65000, description: "Bobina de encendido de repuesto para sistema eléctrico.", stock: 0 },
  { sku: "BUJ-004", name: "Regulador de Voltaje", category: "electrico", price: 55000, description: "Regulador/rectificador de voltaje para el sistema de carga.", stock: 10 },
];

function imageUrlFor(sku: string): string {
  return `https://picsum.photos/seed/${sku}/600/400`;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

  try {
    const tenant = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, whatsapp_number)
       VALUES ('ForMotos Test', $1)
       ON CONFLICT (whatsapp_number) DO UPDATE SET whatsapp_number = EXCLUDED.whatsapp_number
       RETURNING id`,
      [TEST_TENANT_WHATSAPP_NUMBER],
    );
    const tenantId = tenant.rows[0]!.id;

    let count = 0;
    for (const producto of PRODUCTOS) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO products (tenant_id, sku, name, category, price, description, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, sku) DO UPDATE SET
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           price = EXCLUDED.price,
           description = EXCLUDED.description,
           image_url = EXCLUDED.image_url
         RETURNING id`,
        [
          tenantId,
          producto.sku,
          producto.name,
          producto.category,
          producto.price,
          producto.description,
          imageUrlFor(producto.sku),
        ],
      );
      const productId = result.rows[0]!.id;

      // inventory no tiene constraint única sobre (tenant_id, product_id)
      // — se borra y se vuelve a insertar para que el script sea
      // idempotente (evita filas duplicadas si se corre varias veces).
      await pool.query(`DELETE FROM inventory WHERE product_id = $1`, [productId]);
      await pool.query(
        `INSERT INTO inventory (tenant_id, product_id, stock_quantity) VALUES ($1, $2, $3)`,
        [tenantId, productId, producto.stock],
      );
      count++;
    }

    const categorias = new Set(PRODUCTOS.map((p) => p.category));
    console.log(`Tenant de prueba: ${tenantId}`);
    console.log(`Productos sembrados: ${count} en ${categorias.size} categorías`);
    console.log(`Sin stock: ${PRODUCTOS.filter((p) => p.stock === 0).length}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
