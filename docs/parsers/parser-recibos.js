// parser-recibos.js
// Parser de PDFs de recibos Marval (recibo_contrib_v4.pdf, recibo_contrib_v4_rrhh.pdf).
// Port fiel desde src/parser_recibos.py.
//
// Módulo ES, sin dependencias de DOM/window: importable en Node (ESM) y en el
// navegador (<script type="module">). La extracción de texto del PDF se hace
// aparte (ver pdf-extract.js); aquí el caller inyecta el texto ya extraído.

// Alternativa de mes (igual que MESES en el Python). Sin grupo de captura: usa (?:...).
const MESES =
  '(?:Enero|Febrero|Marzo|Abril|Mayo|Junio|' +
  'Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)';

// Redondeo a 2 decimales (equivalente a round(x, 2) del Python para los montos
// que maneja este parser). Nota: Python usa banker's rounding; JS Math.round
// redondea ".5" hacia arriba. Para los importes contables involucrados la
// diferencia no se observa; cualquier divergencia se verifica por separado.
function _round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Convierte un string de dinero argentino o US a number.
 *
 * Maneja: '$ 1.234.567,89' (AR) y '$10,963,803.18' (US).
 * Devuelve null cuando el Python devuelve None.
 */
export function parseMoney(s) {
  if (!s) {
    return null;
  }
  // re.sub(r'[$\s]', '', str(s)).strip() -> elimina '$' y todo whitespace.
  s = String(s).replace(/[$\s]/g, '').trim();
  if (!s || s === '-' || s === '') {
    return null;
  }
  // Formato US: termina en .XX (uno o dos dígitos decimales tras el punto).
  if (/^-?[\d,]+\.\d{1,2}$/.test(s)) {
    return parseFloat(s.replace(/,/g, ''));
  }
  // Formato AR: termina en ,XX.
  if (/^-?[\d.]+,\d{1,2}$/.test(s)) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  // Entero plano.
  if (/^-?\d+$/.test(s)) {
    return parseFloat(s);
  }
  return null;
}

/**
 * Parsea 'CODE Description [UNIT] $ AMOUNT' -> Concepto, o null.
 * @returns {{codigo:string, descripcion:string, monto:number, columna:string}|null}
 */
function _parseConceptoLine(line) {
  // re.match -> anclado al inicio. El patrón ya incluía '^' y '$'.
  const m = line.trim().match(/^(-?\d{3,6})\s+(.+?)\s+\$\s*(-?[\d.,]+)\s*$/);
  if (!m) {
    return null;
  }
  const code = m[1];
  const rawDesc = m[2].trim();
  const amountStr = m[3];
  // Quita números de unidad/base al final de la descripción (ej. "Jubilación 11,00").
  const desc = rawDesc.replace(/\s+\d{1,3}(?:,\d+)?\s*$/, '').trim();
  const amount = parseMoney(amountStr);
  if (amount === null) {
    return null;
  }
  return { codigo: code, descripcion: desc, monto: amount, columna: '' };
}

// Crea un ReciboEmpleado con los defaults del dataclass del Python.
function _nuevoRecibo(pageNum) {
  return {
    legajo: '',
    nombre: '',
    bruto: null,
    neto: null,
    total_contribuciones: null,
    costo_empleador: null,
    composicion_rem: null,
    composicion_no_rem: null,
    composicion_desc: null,
    conceptos: [],
    contribuciones: [],
    porcentajes_torta: [],
    paginas: [pageNum],
    n_paginas: 1,
    errores_parse: [],
  };
}

/**
 * Parsea una página (texto) -> ReciboEmpleado o null.
 */
function _parsePage(text, pageNum) {
  const lines = text.split('\n').map((ln) => ln.trim());

  const rp = _nuevoRecibo(pageNum);

  // Máquina de estados.
  let state = 'HEADER';

  for (const line of lines) {
    if (!line) {
      continue;
    }

    // --- HEADER: busca legajo + nombre + bruto ---
    if (state === 'HEADER') {
      const reHeader = new RegExp(
        MESES + '\\s+\\d{4}\\s+(.+?)\\s+(\\d{3,6})\\s+\\$\\s*([\\d.,]+)'
      );
      const m = line.match(reHeader);
      if (m) {
        rp.nombre = m[1].trim();
        // Normalizar legajo igual que la liquidación (sin ceros a la
        // izquierda) para que '0826' (recibo) matchee '826' (liqui).
        rp.legajo = m[2].trim().replace(/^0+/, '') || '0';
        state = 'PRE_CONTRIB';
        continue;
      }
    }

    // --- COSTO TOTAL EMPLEADOR (puede aparecer en cualquier lugar antes de contribuciones) ---
    if (state === 'HEADER' || state === 'PRE_CONTRIB' || state === 'CONTRIB') {
      const m = line.match(/COSTO TOTAL EMPLEADOR\s+\$\s*([\d.,]+)/);
      if (m) {
        rp.costo_empleador = parseMoney(m[1]);
      }
    }

    // --- Inicio del primer bloque CONCEPTO = sección de contribuciones ---
    if (state === 'PRE_CONTRIB' && line === 'CONCEPTO UNIDAD BASE MONTO') {
      state = 'CONTRIB';
      continue;
    }

    if (state === 'CONTRIB') {
      const m = line.match(/SUB TOTAL CONTRIBUCIONES EMPLEADOR\s+\$\s*([\d.,]+)/);
      if (m) {
        rp.total_contribuciones = parseMoney(m[1]);
        state = 'PRE_CONCEPTOS';
        continue;
      }
      const c = _parseConceptoLine(line);
      if (c) {
        rp.contribuciones.push(c);
      }
    }

    // --- Entre contribuciones y conceptos: obtener SUELDO BRUTO ---
    if (state === 'PRE_CONCEPTOS') {
      const m = line.match(/^SUELDO BRUTO\s+\$\s*([\d.,]+)/);
      if (m) {
        rp.bruto = parseMoney(m[1]);
        continue;
      }
      if (line === 'CONCEPTO UNIDAD BASE MONTO') {
        state = 'CONCEPTOS';
        continue;
      }
    }

    // --- Sección Haberes / Descuentos ---
    if (state === 'CONCEPTOS') {
      // COMPOSICION SALARIAL marca el fin de los conceptos.
      const m = line.match(
        /Remunerativo:\s*\$\s*([\d,.]+)\s+No Remunerativo:\s*\$\s*([\d,.]+)\s+Descuentos:\s*\$\s*([\d,.]+)/
      );
      if (m) {
        rp.composicion_rem = parseMoney(m[1]);
        rp.composicion_no_rem = parseMoney(m[2]);
        rp.composicion_desc = parseMoney(m[3]);
        state = 'POST_CONCEPTOS';
        continue;
      }
      const c = _parseConceptoLine(line);
      if (c) {
        rp.conceptos.push(c);
      }
    }

    // --- Después de COMPOSICION SALARIAL: buscar SUELDO NETO ---
    if (state === 'POST_CONCEPTOS') {
      const m = line.match(/^SUELDO NETO\s+\$\s*([\d.,]+)/);
      if (m) {
        rp.neto = parseMoney(m[1]);
        state = 'PIE';
        continue;
      }
    }

    // --- Porcentajes del gráfico de torta ---
    if (state === 'PIE') {
      const matches = line.matchAll(/(\d{1,2}\.\d{2})%/g);
      for (const pct of matches) {
        rp.porcentajes_torta.push(parseFloat(pct[1]));
      }
    }
  }

  if (!rp.legajo) {
    rp.errores_parse.push(`Página ${pageNum}: no se detectó legajo`);
    return null;
  }

  return rp;
}

/**
 * Suma los datos de la página extra dentro de base (empleados multi-página).
 */
function _mergePages(base, extra) {
  base.conceptos.push(...extra.conceptos);
  base.contribuciones.push(...extra.contribuciones);
  base.paginas.push(...extra.paginas);
  base.n_paginas += 1;
  base.porcentajes_torta.push(...extra.porcentajes_torta);

  for (const field of ['bruto', 'neto', 'total_contribuciones', 'costo_empleador']) {
    const bv = base[field];
    const ev = extra[field];
    if (bv !== null && ev !== null) {
      base[field] = _round2(bv + ev);
    } else if (ev !== null) {
      base[field] = ev;
    }
  }

  for (const field of ['composicion_rem', 'composicion_no_rem', 'composicion_desc']) {
    const bv = base[field];
    const ev = extra[field];
    if (bv !== null && ev !== null) {
      base[field] = _round2(bv + ev);
    } else if (ev !== null) {
      base[field] = ev;
    }
  }
}

/**
 * Parsea uno o más PDFs de recibos. Devuelve un objeto-mapa indexado por legajo.
 *
 * @param {string[][]} pagesByFile - un array por archivo PDF, con el texto de
 *   cada página (string) en orden.
 * @returns {Object<string, Object>} mapa { [legajo]: ReciboEmpleado }
 */
export function parseRecibos(pagesByFile) {
  const results = {};

  for (const pages of pagesByFile) {
    // page_num arranca en 1 por cada archivo (igual que enumerate(pdf.pages, 1)).
    let pageNum = 0;
    for (const page of pages) {
      pageNum += 1;
      const text = page || '';
      const rp = _parsePage(text, pageNum);
      if (rp === null) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(results, rp.legajo)) {
        _mergePages(results[rp.legajo], rp);
      } else {
        results[rp.legajo] = rp;
      }
    }
  }

  return results;
}
