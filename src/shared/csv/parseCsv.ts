/**
 * Parser mínimo de CSV (sin dependencia externa, ver la extensión post-
 * Fase 14 en docs/fase-14-catalogo-extendido/README.md) — soporta campos
 * entre comillas con comas/comillas escapadas (`""`), pero NO campos con
 * saltos de línea embebidos (cada fila del archivo debe ser una sola línea
 * de texto). Suficiente para la carga masiva de productos: una fila real
 * de catálogo (SKU/nombre/precio/stock/talla/color) nunca necesita un
 * salto de línea dentro de un campo.
 */
export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

function parseLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function parseCsv(text: string): ParsedCsv {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = parseLine(lines[0]!).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header] = (values[i] ?? "").trim();
    });
    return row;
  });

  return { headers, rows };
}
