/**
 * Herramienta manual (no forma parte de la app ni de los tests
 * automatizados): siembra un catálogo de prueba de 100 productos de una
 * tienda de repuestos/accesorios de moto (ForMotos), repartidos en varias
 * categorías (algunas con jerarquía real de hasta 4 niveles, ver Fase 14)
 * con varios productos cada una — para poder probar en local el panel
 * admin (src/admin/adminPanel.ts), la tool consultar_inventario con
 * description/image_url/variantes, y el envío de imagen por WhatsApp.
 *
 * Reescrito para la Fase 14 (ver docs/fase-14-catalogo-extendido/adrs/
 * ADR-026-*.md): agent-sale es mono-tenant desde ADR-032 (ya no siembra un
 * tenant de prueba, la versión anterior de este script insertaba
 * `tenant_id`, columna eliminada en la migración 0036 — este script
 * llevaba roto desde ese merge, nadie lo había corrido después). Cada
 * producto se asigna al aliado genérico sembrado por la migración 0039
 * ("Catálogo propio") y a un nodo real del árbol de `product_categories`;
 * la mayoría tiene una sola variante (sin talla/color), un par de
 * productos representativos (un casco, unos guantes) tienen variantes de
 * talla reales para poder probar en local el comportamiento de "preguntar
 * variante antes de cotizar".
 *
 * Uso:
 *   npm run seed:catalogo-prueba
 */
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

interface VarianteProducto {
  sku: string;
  attributes: Record<string, string>;
  price: number;
  stock: number;
}

interface ProductoPrueba {
  name: string;
  categoryPath: string[];
  description: string;
  variants: VarianteProducto[];
}

function unicaVariante(sku: string, price: number, stock: number): VarianteProducto[] {
  return [{ sku, attributes: {}, price, stock }];
}

// 100 productos en 16 categorías (agrupadas en 4 familias + el caso real de
// 4 niveles de "Para motos › Otros para motos › Iluminación › Exploradoras"
// para las luces auxiliares), varios por categoría a propósito (para poder
// probar filtros/búsquedas por categoría y por nombre en local).
const PROTECCION = ["Protección personal"];
const REPUESTOS = ["Repuestos y mantenimiento"];
const ACCESORIOS_EQUIPO = ["Accesorios y equipamiento"];

const PRODUCTOS: ProductoPrueba[] = [
  // Cascos — el primero con variantes de talla real (S/M/L), para probar
  // "preguntar variante antes de cotizar".
  {
    name: "Casco Integral Thunder Road",
    categoryPath: [...PROTECCION, "Cascos"],
    description: "Casco integral con visor antirayas y ventilación regulable, ideal para carretera.",
    variants: [
      { sku: "CAS-001-S", attributes: { talla: "S" }, price: 380000, stock: 4 },
      { sku: "CAS-001-M", attributes: { talla: "M" }, price: 380000, stock: 5 },
      { sku: "CAS-001-L", attributes: { talla: "L" }, price: 380000, stock: 3 },
    ],
  },
  { name: "Casco Integral Storm GT", categoryPath: [...PROTECCION, "Cascos"], description: "Casco integral de fibra de vidrio, doble densidad de espuma para mayor absorción de impacto.", variants: unicaVariante("CAS-002", 420000, 8) },
  { name: "Casco Abierto Urban Rider", categoryPath: [...PROTECCION, "Cascos"], description: "Casco abierto liviano para uso urbano, con visor solar interno.", variants: unicaVariante("CAS-003", 210000, 15) },
  { name: "Casco Modular Cross Tech", categoryPath: [...PROTECCION, "Cascos"], description: "Casco modular con mentonera abatible, permite usarlo integral o abierto.", variants: unicaVariante("CAS-004", 450000, 0) },
  { name: "Casco Infantil SafeKid", categoryPath: [...PROTECCION, "Cascos"], description: "Casco integral talla infantil, colores llamativos y correa de seguridad reforzada.", variants: unicaVariante("CAS-005", 150000, 10) },
  { name: "Casco Integral Racing Pro", categoryPath: [...PROTECCION, "Cascos"], description: "Casco de competición homologado, aerodinámica optimizada para alta velocidad.", variants: unicaVariante("CAS-006", 480000, 5) },
  { name: "Casco Abierto Vintage Cafe", categoryPath: [...PROTECCION, "Cascos"], description: "Casco estilo retro para motos café racer, visor incluido.", variants: unicaVariante("CAS-007", 230000, 9) },
  { name: "Casco Cross Enduro X", categoryPath: [...PROTECCION, "Cascos"], description: "Casco para motocross con visera larga y ventilación frontal amplia.", variants: unicaVariante("CAS-008", 260000, 7) },

  // Guantes — el primero también con variantes de talla real.
  {
    name: "Guantes de Cuero Touring",
    categoryPath: [...PROTECCION, "Guantes"],
    description: "Guantes de cuero genuino con protección en nudillos, para viajes largos.",
    variants: [
      { sku: "GUA-001-S", attributes: { talla: "S" }, price: 95000, stock: 6 },
      { sku: "GUA-001-M", attributes: { talla: "M" }, price: 95000, stock: 9 },
      { sku: "GUA-001-L", attributes: { talla: "L" }, price: 95000, stock: 5 },
    ],
  },
  { name: "Guantes Racing con Protección", categoryPath: [...PROTECCION, "Guantes"], description: "Guantes con protección rígida en nudillos y palma antideslizante para uso deportivo.", variants: unicaVariante("GUA-002", 120000, 14) },
  { name: "Guantes Urbanos Táctiles", categoryPath: [...PROTECCION, "Guantes"], description: "Guantes livianos compatibles con pantalla táctil, uso diario en ciudad.", variants: unicaVariante("GUA-003", 55000, 25) },
  { name: "Guantes Impermeables Invierno", categoryPath: [...PROTECCION, "Guantes"], description: "Guantes forrados e impermeables para clima frío y lluvia.", variants: unicaVariante("GUA-004", 85000, 0) },
  { name: "Guantes Cross con Nudillera", categoryPath: [...PROTECCION, "Guantes"], description: "Guantes de motocross con nudillera de protección y agarre reforzado.", variants: unicaVariante("GUA-005", 70000, 11) },
  { name: "Guantes de Malla Verano", categoryPath: [...PROTECCION, "Guantes"], description: "Guantes transpirables de malla para clima cálido.", variants: unicaVariante("GUA-006", 45000, 18) },
  { name: "Guantes Mujer Comfort Fit", categoryPath: [...PROTECCION, "Guantes"], description: "Guantes diseñados para mano femenina, ajuste ergonómico y protección básica.", variants: unicaVariante("GUA-007", 60000, 13) },

  // Chaquetas
  { name: "Chaqueta Textil Touring", categoryPath: [...PROTECCION, "Chaquetas"], description: "Chaqueta textil impermeable con protecciones removibles en hombros y codos.", variants: unicaVariante("CHA-001", 320000, 9) },
  { name: "Chaqueta de Cuero Classic", categoryPath: [...PROTECCION, "Chaquetas"], description: "Chaqueta de cuero genuino estilo clásico, forro térmico desmontable.", variants: unicaVariante("CHA-002", 480000, 6) },
  { name: "Chaqueta Racing con Protecciones", categoryPath: [...PROTECCION, "Chaquetas"], description: "Chaqueta deportiva con protecciones CE en espalda, hombros y codos.", variants: unicaVariante("CHA-003", 550000, 4) },
  { name: "Chaqueta Impermeable All Weather", categoryPath: [...PROTECCION, "Chaquetas"], description: "Chaqueta todo clima con membrana impermeable y forro térmico.", variants: unicaVariante("CHA-004", 280000, 0) },
  { name: "Chaqueta Mesh Verano", categoryPath: [...PROTECCION, "Chaquetas"], description: "Chaqueta de malla transpirable con protecciones básicas, ideal para calor.", variants: unicaVariante("CHA-005", 190000, 12) },
  { name: "Chaleco Reflectivo Seguridad", categoryPath: [...PROTECCION, "Chaquetas"], description: "Chaleco reflectivo de alta visibilidad para conducción nocturna.", variants: unicaVariante("CHA-006", 35000, 30) },
  { name: "Chaqueta Térmica Invierno", categoryPath: [...PROTECCION, "Chaquetas"], description: "Chaqueta térmica acolchada para bajas temperaturas.", variants: unicaVariante("CHA-007", 260000, 8) },

  // Llantas y neumáticos
  { name: "Llanta Delantera Sport 110/70-17", categoryPath: [...REPUESTOS, "Llantas y neumáticos"], description: "Llanta deportiva delantera, buen agarre en seco y mojado.", variants: unicaVariante("LLA-001", 280000, 10) },
  { name: "Llanta Trasera Sport 140/70-17", categoryPath: [...REPUESTOS, "Llantas y neumáticos"], description: "Llanta deportiva trasera de alto rendimiento.", variants: unicaVariante("LLA-002", 320000, 10) },
  { name: "Llanta Todo Terreno 90/90-19", categoryPath: [...REPUESTOS, "Llantas y neumáticos"], description: "Llanta mixta para asfalto y trocha, taco resistente.", variants: unicaVariante("LLA-003", 260000, 7) },
  { name: "Llanta Urbana 80/100-18", categoryPath: [...REPUESTOS, "Llantas y neumáticos"], description: "Llanta económica para uso urbano diario.", variants: unicaVariante("LLA-004", 190000, 15) },
  { name: "Llanta Touring 120/70-17", categoryPath: [...REPUESTOS, "Llantas y neumáticos"], description: "Llanta de larga duración pensada para viajes de carretera.", variants: unicaVariante("LLA-005", 300000, 0) },
  { name: "Cámara de Aire Reforzada", categoryPath: [...REPUESTOS, "Llantas y neumáticos"], description: "Cámara de aire de caucho reforzado, varias medidas disponibles.", variants: unicaVariante("LLA-006", 35000, 40) },
  { name: "Llanta Scooter 120/70-12", categoryPath: [...REPUESTOS, "Llantas y neumáticos"], description: "Llanta para scooter con buen agarre urbano.", variants: unicaVariante("LLA-007", 175000, 9) },

  // Aceites y lubricantes
  { name: "Aceite Sintético 10W-40 1L", categoryPath: [...REPUESTOS, "Aceites y lubricantes"], description: "Aceite 100% sintético para motor 4 tiempos, alta protección térmica.", variants: unicaVariante("ACE-001", 58000, 35) },
  { name: "Aceite Semisintético 20W-50 1L", categoryPath: [...REPUESTOS, "Aceites y lubricantes"], description: "Aceite semisintético de uso general para motos de trabajo diario.", variants: unicaVariante("ACE-002", 42000, 40) },
  { name: "Aceite Mineral 20W-50 1L", categoryPath: [...REPUESTOS, "Aceites y lubricantes"], description: "Aceite mineral económico para motores de baja exigencia.", variants: unicaVariante("ACE-003", 28000, 50) },
  { name: "Lubricante de Cadena Spray", categoryPath: [...REPUESTOS, "Aceites y lubricantes"], description: "Lubricante en spray para cadena, resistente al agua.", variants: unicaVariante("ACE-004", 25000, 45) },
  { name: "Aceite de Horquilla 10W", categoryPath: [...REPUESTOS, "Aceites y lubricantes"], description: "Aceite específico para suspensión delantera.", variants: unicaVariante("ACE-005", 32000, 0) },
  { name: "Grasa para Rodamientos", categoryPath: [...REPUESTOS, "Aceites y lubricantes"], description: "Grasa multipropósito para rodamientos y bujes.", variants: unicaVariante("ACE-006", 18000, 22) },
  { name: "Aditivo Limpiador de Inyectores", categoryPath: [...REPUESTOS, "Aceites y lubricantes"], description: "Aditivo para limpiar inyectores y mejorar el rendimiento del motor.", variants: unicaVariante("ACE-007", 30000, 17) },

  // Filtros
  { name: "Filtro de Aceite Universal", categoryPath: [...REPUESTOS, "Filtros"], description: "Filtro de aceite compatible con la mayoría de motores 150-250cc.", variants: unicaVariante("FIL-001", 22000, 30) },
  { name: "Filtro de Aire Deportivo", categoryPath: [...REPUESTOS, "Filtros"], description: "Filtro de aire de alto flujo lavable y reutilizable.", variants: unicaVariante("FIL-002", 38000, 20) },
  { name: "Filtro de Aire Original", categoryPath: [...REPUESTOS, "Filtros"], description: "Filtro de aire de repuesto según especificación de fábrica.", variants: unicaVariante("FIL-003", 25000, 25) },
  { name: "Filtro de Combustible", categoryPath: [...REPUESTOS, "Filtros"], description: "Filtro de combustible en línea, evita impurezas en el sistema de inyección.", variants: unicaVariante("FIL-004", 15000, 0) },
  { name: "Filtro de Aire de Alto Flujo", categoryPath: [...REPUESTOS, "Filtros"], description: "Filtro deportivo de alto flujo para mayor potencia.", variants: unicaVariante("FIL-005", 45000, 12) },
  { name: "Filtro de Aceite Racing", categoryPath: [...REPUESTOS, "Filtros"], description: "Filtro de aceite de alto rendimiento para uso deportivo.", variants: unicaVariante("FIL-006", 28000, 14) },

  // Frenos
  { name: "Pastillas de Freno Delanteras Cerámicas", categoryPath: [...REPUESTOS, "Frenos"], description: "Pastillas cerámicas de alto rendimiento y baja generación de polvo.", variants: unicaVariante("FRE-001", 65000, 18) },
  { name: "Pastillas de Freno Traseras Orgánicas", categoryPath: [...REPUESTOS, "Frenos"], description: "Pastillas orgánicas de frenado suave para uso diario.", variants: unicaVariante("FRE-002", 45000, 20) },
  { name: "Disco de Freno Delantero Flotante", categoryPath: [...REPUESTOS, "Frenos"], description: "Disco flotante de alto rendimiento, mejor disipación de calor.", variants: unicaVariante("FRE-003", 180000, 6) },
  { name: "Disco de Freno Trasero", categoryPath: [...REPUESTOS, "Frenos"], description: "Disco de freno trasero de repuesto original.", variants: unicaVariante("FRE-004", 150000, 0) },
  { name: "Líquido de Frenos DOT 4", categoryPath: [...REPUESTOS, "Frenos"], description: "Líquido de frenos DOT 4 para sistemas hidráulicos.", variants: unicaVariante("FRE-005", 22000, 35) },
  { name: "Kit de Mangueras de Freno Trenzadas", categoryPath: [...REPUESTOS, "Frenos"], description: "Mangueras trenzadas de acero para mejor tacto de frenado.", variants: unicaVariante("FRE-006", 130000, 8) },
  { name: "Bomba de Freno Trasera", categoryPath: [...REPUESTOS, "Frenos"], description: "Bomba de freno trasera de repuesto.", variants: unicaVariante("FRE-007", 95000, 5) },

  // Cadenas y kits de arrastre
  { name: "Kit de Arrastre Completo 428H", categoryPath: [...REPUESTOS, "Cadenas y kits de arrastre"], description: "Kit completo (cadena, piñón, corona) para motos de 150-200cc.", variants: unicaVariante("CAD-001", 220000, 10) },
  { name: "Cadena de Transmisión 520", categoryPath: [...REPUESTOS, "Cadenas y kits de arrastre"], description: "Cadena reforzada 520 para motos deportivas.", variants: unicaVariante("CAD-002", 130000, 12) },
  { name: "Piñón Delantero", categoryPath: [...REPUESTOS, "Cadenas y kits de arrastre"], description: "Piñón delantero de acero de alta resistencia.", variants: unicaVariante("CAD-003", 40000, 0) },
  { name: "Corona Trasera", categoryPath: [...REPUESTOS, "Cadenas y kits de arrastre"], description: "Corona trasera de aluminio liviano.", variants: unicaVariante("CAD-004", 90000, 9) },
  { name: "Kit de Arrastre Reforzado Racing", categoryPath: [...REPUESTOS, "Cadenas y kits de arrastre"], description: "Kit de arrastre reforzado para uso deportivo o de competición.", variants: unicaVariante("CAD-005", 320000, 4) },
  { name: "Tensor de Cadena Ajustable", categoryPath: [...REPUESTOS, "Cadenas y kits de arrastre"], description: "Tensor de cadena ajustable para mantener la tensión correcta.", variants: unicaVariante("CAD-006", 55000, 15) },

  // Baterías
  { name: "Batería Gel 12V 9Ah", categoryPath: [...REPUESTOS, "Baterías"], description: "Batería de gel libre de mantenimiento, mayor vida útil.", variants: unicaVariante("BAT-001", 220000, 14) },
  { name: "Batería de Litio Ultraligera", categoryPath: [...REPUESTOS, "Baterías"], description: "Batería de litio de bajo peso y arranque instantáneo.", variants: unicaVariante("BAT-002", 380000, 5) },
  { name: "Batería Convencional 12V 5Ah", categoryPath: [...REPUESTOS, "Baterías"], description: "Batería de plomo-ácido convencional, requiere mantenimiento.", variants: unicaVariante("BAT-003", 120000, 0) },
  { name: "Cargador de Batería Inteligente", categoryPath: [...REPUESTOS, "Baterías"], description: "Cargador inteligente con corte automático de carga.", variants: unicaVariante("BAT-004", 85000, 18) },
  { name: "Batería AGM 12V 12Ah", categoryPath: [...REPUESTOS, "Baterías"], description: "Batería AGM sellada de alta durabilidad.", variants: unicaVariante("BAT-005", 260000, 7) },

  // Luces y faros — caso real de 4 niveles: "Para motos › Otros para
  // motos › Iluminación › Exploradoras" para las luces auxiliares.
  { name: "Faro Delantero LED", categoryPath: ["Para motos", "Otros para motos", "Iluminación"], description: "Faro delantero LED de alta luminosidad y bajo consumo.", variants: unicaVariante("LUZ-001", 150000, 10) },
  { name: "Kit de Luces LED H4", categoryPath: ["Para motos", "Otros para motos", "Iluminación"], description: "Kit de bombillas LED H4 plug and play.", variants: unicaVariante("LUZ-002", 90000, 20) },
  { name: "Direccionales LED Ahumadas", categoryPath: ["Para motos", "Otros para motos", "Iluminación"], description: "Par de direccionales LED con lente ahumado.", variants: unicaVariante("LUZ-003", 45000, 25) },
  { name: "Luz Trasera LED con Freno", categoryPath: ["Para motos", "Otros para motos", "Iluminación"], description: "Luz trasera LED integrada con función de freno.", variants: unicaVariante("LUZ-004", 55000, 0) },
  { name: "Luces Auxiliares Neblineras", categoryPath: ["Para motos", "Otros para motos", "Iluminación", "Exploradoras"], description: "Par de luces auxiliares para neblina y baja visibilidad.", variants: unicaVariante("LUZ-005", 110000, 8) },
  { name: "Luz LED para Placa", categoryPath: ["Para motos", "Otros para motos", "Iluminación"], description: "Luz LED pequeña para iluminación de placa.", variants: unicaVariante("LUZ-006", 20000, 30) },

  // Espejos
  { name: "Espejos Retrovisores Deportivos", categoryPath: [...ACCESORIOS_EQUIPO, "Espejos"], description: "Par de espejos deportivos de perfil aerodinámico.", variants: unicaVariante("ESP-001", 65000, 16) },
  { name: "Espejos Retrovisores Clásicos", categoryPath: [...ACCESORIOS_EQUIPO, "Espejos"], description: "Par de espejos redondos estilo clásico.", variants: unicaVariante("ESP-002", 55000, 14) },
  { name: "Espejos Convexos Antivibración", categoryPath: [...ACCESORIOS_EQUIPO, "Espejos"], description: "Espejos convexos que reducen el punto ciego y la vibración.", variants: unicaVariante("ESP-003", 70000, 0) },
  { name: "Espejo Retrovisor Universal Cromado", categoryPath: [...ACCESORIOS_EQUIPO, "Espejos"], description: "Espejo universal cromado, encaja en la mayoría de modelos.", variants: unicaVariante("ESP-004", 35000, 22) },
  { name: "Espejos Plegables Racing", categoryPath: [...ACCESORIOS_EQUIPO, "Espejos"], description: "Espejos plegables de bajo perfil para uso deportivo.", variants: unicaVariante("ESP-005", 90000, 9) },

  // Escapes
  { name: "Escape Deportivo Slip-On", categoryPath: [...ACCESORIOS_EQUIPO, "Escapes"], description: "Escape deportivo de instalación simple, mejora sonido y peso.", variants: unicaVariante("ESC-001", 480000, 6) },
  { name: "Escape Completo Racing", categoryPath: [...ACCESORIOS_EQUIPO, "Escapes"], description: "Sistema de escape completo de alto rendimiento para competición.", variants: unicaVariante("ESC-002", 950000, 2) },
  { name: "Silenciador Universal", categoryPath: [...ACCESORIOS_EQUIPO, "Escapes"], description: "Silenciador universal adaptable a varios modelos.", variants: unicaVariante("ESC-003", 280000, 8) },
  { name: "Protector de Escape Carbono", categoryPath: [...ACCESORIOS_EQUIPO, "Escapes"], description: "Protector térmico de fibra de carbono para el escape.", variants: unicaVariante("ESC-004", 95000, 0) },
  { name: "Escape Megáfono Clásico", categoryPath: [...ACCESORIOS_EQUIPO, "Escapes"], description: "Escape estilo megáfono para motos clásicas y café racer.", variants: unicaVariante("ESC-005", 320000, 5) },
  { name: "Empaque de Escape Universal", categoryPath: [...ACCESORIOS_EQUIPO, "Escapes"], description: "Empaque de repuesto para unión del escape al motor.", variants: unicaVariante("ESC-006", 12000, 40) },

  // Accesorios
  { name: "Maleta Lateral Rígida", categoryPath: [...ACCESORIOS_EQUIPO, "Accesorios"], description: "Par de maletas laterales rígidas resistentes al agua.", variants: unicaVariante("ACC-001", 420000, 5) },
  { name: "Baúl Trasero 40L", categoryPath: [...ACCESORIOS_EQUIPO, "Accesorios"], description: "Baúl trasero de 40 litros con respaldo acolchado.", variants: unicaVariante("ACC-002", 250000, 9) },
  { name: "Cubre Asiento Impermeable", categoryPath: [...ACCESORIOS_EQUIPO, "Accesorios"], description: "Cubre asiento impermeable universal.", variants: unicaVariante("ACC-003", 40000, 25) },
  { name: "Soporte para Celular", categoryPath: [...ACCESORIOS_EQUIPO, "Accesorios"], description: "Soporte ajustable para celular con agarre antivibración.", variants: unicaVariante("ACC-004", 35000, 0) },
  { name: "Alarma Antirrobo con Sensor", categoryPath: [...ACCESORIOS_EQUIPO, "Accesorios"], description: "Alarma con sensor de movimiento y control remoto.", variants: unicaVariante("ACC-005", 130000, 12) },
  { name: "Cubierta para Moto Impermeable", categoryPath: [...ACCESORIOS_EQUIPO, "Accesorios"], description: "Cubierta impermeable con protección UV.", variants: unicaVariante("ACC-006", 60000, 20) },
  { name: "Portaequipaje Trasero", categoryPath: [...ACCESORIOS_EQUIPO, "Accesorios"], description: "Portaequipaje trasero de acero para carga adicional.", variants: unicaVariante("ACC-007", 75000, 10) },
  { name: "Candado de Disco con Alarma", categoryPath: [...ACCESORIOS_EQUIPO, "Accesorios"], description: "Candado de disco con alarma sonora antirrobo.", variants: unicaVariante("ACC-008", 90000, 14) },

  // Herramientas
  { name: "Kit de Herramientas Básico", categoryPath: [...ACCESORIOS_EQUIPO, "Herramientas"], description: "Kit básico de herramientas para mantenimiento en casa.", variants: unicaVariante("HER-001", 85000, 16) },
  { name: "Llave de Cruz para Moto", categoryPath: [...ACCESORIOS_EQUIPO, "Herramientas"], description: "Llave de cruz multipropósito para tuercas y pernos.", variants: unicaVariante("HER-002", 30000, 20) },
  { name: "Compresor de Aire Portátil", categoryPath: [...ACCESORIOS_EQUIPO, "Herramientas"], description: "Compresor portátil 12V para inflar llantas.", variants: unicaVariante("HER-003", 180000, 0) },
  { name: "Multímetro Digital", categoryPath: [...ACCESORIOS_EQUIPO, "Herramientas"], description: "Multímetro digital para diagnóstico eléctrico básico.", variants: unicaVariante("HER-004", 65000, 11) },
  { name: "Elevador Hidráulico para Moto", categoryPath: [...ACCESORIOS_EQUIPO, "Herramientas"], description: "Elevador hidráulico para mantenimiento y cambio de llantas.", variants: unicaVariante("HER-005", 450000, 3) },

  // Amortiguadores y suspensión
  { name: "Amortiguador Trasero Ajustable", categoryPath: [...REPUESTOS, "Amortiguadores y suspensión"], description: "Amortiguador trasero con ajuste de precarga.", variants: unicaVariante("AMO-001", 320000, 7) },
  { name: "Kit de Amortiguadores Delanteros", categoryPath: [...REPUESTOS, "Amortiguadores y suspensión"], description: "Par de amortiguadores delanteros de repuesto.", variants: unicaVariante("AMO-002", 280000, 6) },
  { name: "Resortes de Suspensión Progresivos", categoryPath: [...REPUESTOS, "Amortiguadores y suspensión"], description: "Resortes progresivos para mejorar la respuesta de la suspensión.", variants: unicaVariante("AMO-003", 150000, 0) },
  { name: "Amortiguador de Dirección", categoryPath: [...REPUESTOS, "Amortiguadores y suspensión"], description: "Amortiguador de dirección para mayor estabilidad en carretera.", variants: unicaVariante("AMO-004", 260000, 4) },
  { name: "Bujes de Suspensión Poliuretano", categoryPath: [...REPUESTOS, "Amortiguadores y suspensión"], description: "Bujes de poliuretano de alta durabilidad.", variants: unicaVariante("AMO-005", 60000, 15) },
  { name: "Kit de Retenes de Horquilla", categoryPath: [...REPUESTOS, "Amortiguadores y suspensión"], description: "Kit de retenes para sellar la horquilla delantera.", variants: unicaVariante("AMO-006", 45000, 18) },

  // Bujías y eléctrico
  { name: "Bujía de Iridio", categoryPath: [...REPUESTOS, "Bujías y eléctrico"], description: "Bujía de iridio de larga duración y mejor encendido.", variants: unicaVariante("BUJ-001", 45000, 24) },
  { name: "Bujía Estándar", categoryPath: [...REPUESTOS, "Bujías y eléctrico"], description: "Bujía estándar de níquel para uso general.", variants: unicaVariante("BUJ-002", 12000, 40) },
  { name: "Bobina de Encendido", categoryPath: [...REPUESTOS, "Bujías y eléctrico"], description: "Bobina de encendido de repuesto para sistema eléctrico.", variants: unicaVariante("BUJ-003", 65000, 0) },
  { name: "Regulador de Voltaje", categoryPath: [...REPUESTOS, "Bujías y eléctrico"], description: "Regulador/rectificador de voltaje para el sistema de carga.", variants: unicaVariante("BUJ-004", 55000, 10) },
];

// Categorías que se marcan como complementarias entre sí (ver
// category_complements, reemplaza el viejo COMPLEMENTARY_CATEGORIES
// hardcodeado de recomendarProducto.ts) — se siembran ambas direcciones.
const CATEGORY_COMPLEMENT_PAIRS: [string[], string[]][] = [
  [[...PROTECCION, "Cascos"], [...PROTECCION, "Guantes"]],
  [[...PROTECCION, "Cascos"], [...PROTECCION, "Chaquetas"]],
];

function imageUrlFor(sku: string): string {
  return `https://picsum.photos/seed/${sku}/600/400`;
}

async function resolveGenericAllyId(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM allies ORDER BY created_at ASC LIMIT 1`,
  );
  const ally = result.rows[0];
  if (!ally) {
    throw new Error(
      "No hay ningún aliado sembrado — corré las migraciones (npm run migrate) antes de este script.",
    );
  }
  return ally.id;
}

const categoryCache = new Map<string, string>();

async function resolveCategoryPath(pool: pg.Pool, path: string[]): Promise<string> {
  let parentId: string | null = null;
  let key = "";
  for (const name of path) {
    key += `/${name}`;
    const cached = categoryCache.get(key);
    if (cached) {
      parentId = cached;
      continue;
    }

    const existingResult = parentId === null
      ? await pool.query<{ id: string }>(
          `SELECT id FROM product_categories WHERE name = $1 AND parent_id IS NULL`,
          [name],
        )
      : await pool.query<{ id: string }>(
          `SELECT id FROM product_categories WHERE name = $1 AND parent_id = $2`,
          [name, parentId],
        );

    let resolvedId: string;
    if (existingResult.rows[0]) {
      resolvedId = existingResult.rows[0].id;
    } else {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO product_categories (parent_id, name) VALUES ($1, $2) RETURNING id`,
        [parentId, name],
      );
      resolvedId = inserted.rows[0]!.id;
    }

    categoryCache.set(key, resolvedId);
    parentId = resolvedId;
  }
  return parentId!;
}

async function upsertProducto(pool: pg.Pool, allyId: string, producto: ProductoPrueba): Promise<void> {
  const categoryId = await resolveCategoryPath(pool, producto.categoryPath);
  const hasVariants = producto.variants.length > 1;
  const baseSku = producto.variants[0]!.sku;

  const existingProduct = await pool.query<{ id: string }>(
    `SELECT p.id FROM products p JOIN product_variants pv ON pv.product_id = p.id WHERE pv.sku = $1`,
    [baseSku],
  );

  const productId =
    existingProduct.rows[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `INSERT INTO products (ally_id, category_id, name, description, image_url, has_variants)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [allyId, categoryId, producto.name, producto.description, imageUrlFor(baseSku), hasVariants],
      )
    ).rows[0]!.id;

  if (existingProduct.rows[0]) {
    await pool.query(
      `UPDATE products SET ally_id = $1, category_id = $2, name = $3, description = $4, image_url = $5, has_variants = $6
       WHERE id = $7`,
      [allyId, categoryId, producto.name, producto.description, imageUrlFor(baseSku), hasVariants, productId],
    );
  }

  for (const variante of producto.variants) {
    const existingVariant = await pool.query<{ id: string }>(
      `SELECT id FROM product_variants WHERE sku = $1`,
      [variante.sku],
    );
    const variantId =
      existingVariant.rows[0]?.id ??
      (
        await pool.query<{ id: string }>(
          `INSERT INTO product_variants (product_id, sku, attributes, price) VALUES ($1, $2, $3, $4) RETURNING id`,
          [productId, variante.sku, JSON.stringify(variante.attributes), variante.price],
        )
      ).rows[0]!.id;

    if (existingVariant.rows[0]) {
      await pool.query(
        `UPDATE product_variants SET product_id = $1, attributes = $2, price = $3, active = true WHERE id = $4`,
        [productId, JSON.stringify(variante.attributes), variante.price, variantId],
      );
    }

    // inventory no tiene constraint única sobre variant_id — se borra y se
    // vuelve a insertar para que el script sea idempotente (evita filas
    // duplicadas si se corre varias veces).
    await pool.query(`DELETE FROM inventory WHERE variant_id = $1`, [variantId]);
    await pool.query(`INSERT INTO inventory (variant_id, stock_quantity) VALUES ($1, $2)`, [
      variantId,
      variante.stock,
    ]);
  }
}

async function seedCategoryComplements(pool: pg.Pool): Promise<void> {
  for (const [pathA, pathB] of CATEGORY_COMPLEMENT_PAIRS) {
    const idA = categoryCache.get(`/${pathA.join("/")}`);
    const idB = categoryCache.get(`/${pathB.join("/")}`);
    if (!idA || !idB) {
      continue;
    }
    await pool.query(
      `INSERT INTO category_complements (category_id, complementary_category_id) VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [idA, idB],
    );
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });

  try {
    const allyId = await resolveGenericAllyId(pool);

    let variantCount = 0;
    for (const producto of PRODUCTOS) {
      await upsertProducto(pool, allyId, producto);
      variantCount += producto.variants.length;
    }
    await seedCategoryComplements(pool);

    const categorias = new Set(categoryCache.keys());
    const sinStock = PRODUCTOS.reduce(
      (count, p) => count + p.variants.filter((v) => v.stock === 0).length,
      0,
    );
    console.log(`Productos sembrados: ${PRODUCTOS.length}`);
    console.log(`Variantes sembradas: ${variantCount}`);
    console.log(`Nodos de categoría: ${categorias.size}`);
    console.log(`Variantes sin stock: ${sinStock}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
