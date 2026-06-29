// parser-liquidacion-xlsx.js
// Parser NUEVO de liquidación en formato Excel (no existe equivalente Python).
// Devuelve la MISMA estructura LiquidacionEmpleado que el parser de PDF, para que
// el validador trate ambos orígenes de forma idéntica.
//
// Formato del Excel (analizado sobre la muestra 'TABU 04.xlsx'): PIVOTE / ANCHO.
//   - Una hoja única; fila 1 (index 0) = encabezados; ~101 columnas.
//   - Una fila por (empleado, fecha de imputación); una COLUMNA por concepto.
//   - Cabecera: col2 EMPLEADO = legajo, col5 'APELLIDO Y NOMBRE' = nombre,
//     col4 FEC_IMPUTACION (fecha). Cols 1-19 son metadata.
//   - Desde col20 hasta col101 (1-based): encabezado 'CODIGO-DESCRIPCION'
//     (ej '1003-SUELDO', '6100-JUBILACION_PAT'). El código = header.split('-')[0]
//     (con maxsplit 1). El monto = valor numérico de la celda.
//   - col70 (1-based), header EXACTO 'NETO' = neto a pagar. Punto de corte:
//       * cols a la IZQUIERDA de NETO  = lado EMPLEADO (haberes y descuentos).
//       * col NETO                     = el neto.
//       * cols a la DERECHA de NETO    = CONTRIBUCIONES / PROVISIONES patronales.
//
// Módulo ES, agnóstico de DOM/window: importable en Node (ESM) y en navegador.
//
// ===== CONTRATO DE DATOS (idéntico en todos los módulos) =====
// Concepto:            { codigo, descripcion, monto, columna }
// LiquidacionEmpleado: { legajo, nombre, bruto, neto, total_rem, total_desc,
//                        total_no_rem, total_contrib, conceptos, n_bloques, errores_parse }

// --- Detección de columnas de UNIDAD (días / porcentajes / cantidades) ---
// Estas columnas del lado empleado NO son montos: son DIAS/UNIDADES/PORCENTAJES.
// Si se tratan como montos, inflan el bruto. Se excluyen por heurística de nombre
// y/o por un set de códigos conocidos.
const _CODIGOS_UNIDAD = new Set([
  '470', '475', '500', '530', '588', '610', '612',
  '1001', '3550', '3970', '7293',
]);

// Subcadenas que marcan un encabezado de unidad (no monetario), case-insensitive.
const _KEYWORDS_UNIDAD = [
  'DIAS', 'PORC', 'UN_', 'U_DIAS', 'LIC_S_GOS', 'P_OBRA_SOC', 'SDOS_',
];

// Aliases conocidos para la columna de legajo (en orden de prioridad).
// Cubre variantes de Meta 4 y otros ERP. La búsqueda es exacta (trim, case-insensitive
// se maneja al comparar en mayúsculas en indicePorAliases).
const _LEGAJO_ALIASES = [
  'EMPLEADO', 'ID_EMPLEADO', 'LEGAJO', 'NRO_LEGAJO', 'N_LEGAJO', 'LEG', 'NRO_LEG',
];

// Aliases conocidos para la columna de nombre/apellido.
const _NOMBRE_ALIASES = [
  'APELLIDO Y NOMBRE',
  'APPELIDO Y NOMBRE',  // typo frecuente en reportes Meta 4
  'APELLIDO_Y_NOMBRE', 'NOMBRE Y APELLIDO', 'NOMBRE',
];

// Convierte un string de dinero AR ('1.234.567,89') o US ('1,234,567.89') a número.
// Replica EXACTAMENTE parse_money del Python. Devuelve null donde Python devuelve None.
function parseMoney(s) {
  if (s === null || s === undefined || s === '') return null;
  // re.sub(r'[$\s]', '', str(s)).strip()
  s = String(s).replace(/[$\s]/g, '').trim();
  if (!s) return null;
  // AR format: 1.234.567,89  -> ^-?(?:\d{1,3}\.)*\d{1,3},\d{2}$
  if (/^-?(?:\d{1,3}\.)*\d{1,3},\d{2}$/.test(s)) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  // US format (fallback): 1,234,567.89 -> ^-?[\d,]+\.\d{1,2}$
  if (/^-?[\d,]+\.\d{1,2}$/.test(s)) {
    return parseFloat(s.replace(/,/g, ''));
  }
  // entero plano -> ^-?\d+$
  if (/^-?\d+$/.test(s)) {
    return parseFloat(s);
  }
  return null;
}

// Normaliza una celda a número. Las celdas de un Excel (raw:true) suelen venir como
// number, pero pueden venir como string (texto con formato AR/US): en ese caso se
// pasa por parseMoney. Devuelve null si no hay valor numérico utilizable.
function valorNumerico(celda) {
  if (celda === null || celda === undefined || celda === '') return null;
  if (typeof celda === 'number') {
    return Number.isFinite(celda) ? celda : null;
  }
  if (typeof celda === 'boolean') return null;
  return parseMoney(celda);
}

// Normaliza legajo: replica lstrip('0') del Python => quitar ceros a izquierda.
function normalizarLegajo(x) {
  return String(x).replace(/^0+/, '') || '0';
}

// ¿El encabezado de concepto corresponde a una columna de UNIDAD (no monetaria)?
function esColumnaUnidad(codigo, descripcion) {
  if (_CODIGOS_UNIDAD.has(codigo)) return true;
  const up = String(descripcion).toUpperCase();
  return _KEYWORDS_UNIDAD.some((kw) => up.indexOf(kw) !== -1);
}

// Localiza el índice (0-based) de una columna por header exacto (trim). Devuelve -1.
function indicePorHeader(headers, nombre) {
  const objetivo = String(nombre).trim();
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h === null || h === undefined) continue;
    if (String(h).trim() === objetivo) return i;
  }
  return -1;
}

// Prueba una lista de aliases en orden de prioridad; devuelve el índice del primero que
// aparezca (comparación case-insensitive), o -1 si ninguno está.
function indicePorAliases(headers, aliases) {
  for (const alias of aliases) {
    const objetivo = alias.toUpperCase();
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (h === null || h === undefined) continue;
      if (String(h).trim().toUpperCase() === objetivo) return i;
    }
  }
  return -1;
}

// Parsea los encabezados y precomputa metadata de cada columna de concepto.
// Devuelve { idxEmpleado, idxNombre, idxNeto, columnas: [{indice, codigo, descripcion,
//            lado:'EMPLEADO'|'CONTRIB', esUnidad}] }.
function parsearEncabezados(headers) {
  const idxEmpleado = indicePorAliases(headers, _LEGAJO_ALIASES);
  const idxNombre = indicePorAliases(headers, _NOMBRE_ALIASES);
  const idxNeto = indicePorHeader(headers, 'NETO');

  const columnas = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h === null || h === undefined) continue;
    const txt = String(h).trim();
    if (!txt) continue;
    // Solo columnas de concepto: patrón 'CODIGO-DESCRIPCION'. Saltear cabecera/metadata.
    const guion = txt.indexOf('-');
    if (guion <= 0) continue; // sin guión, o guión al inicio => no es concepto
    // La columna NETO no es un concepto (es el neto); se trata aparte.
    if (i === idxNeto) continue;

    const codigo = txt.slice(0, guion);
    const descripcion = txt.slice(guion + 1);
    // Solo aceptar como concepto si el código es numérico (evita falsos positivos
    // en metadata que pudiera contener un guión).
    if (!/^\d+$/.test(codigo)) continue;

    // Lado según posición respecto a NETO. Si no se encontró NETO, todo es EMPLEADO.
    let lado;
    if (idxNeto === -1) {
      lado = 'EMPLEADO';
    } else {
      lado = i < idxNeto ? 'EMPLEADO' : 'CONTRIB';
    }

    columnas.push({
      indice: i,
      codigo,
      descripcion,
      lado,
      // Solo las del lado EMPLEADO pueden ser unidades; las CONTRIB siempre son montos.
      esUnidad: lado === 'EMPLEADO' && esColumnaUnidad(codigo, descripcion),
    });
  }

  return { idxEmpleado, idxNombre, idxNeto, columnas };
}

// Fusiona conceptos por código sumando montos (mantiene la descripción del primero).
function fusionarConceptos(conceptos) {
  const merged = {};
  const orden = [];
  for (const c of conceptos) {
    if (Object.prototype.hasOwnProperty.call(merged, c.codigo)) {
      merged[c.codigo] = {
        codigo: c.codigo,
        descripcion: merged[c.codigo].descripcion,
        monto: Math.round((merged[c.codigo].monto + c.monto) * 100) / 100,
        columna: merged[c.codigo].columna,
      };
    } else {
      merged[c.codigo] = c;
      orden.push(c.codigo);
    }
  }
  return orden.map((k) => merged[k]);
}

// Suma redondeada a 2 decimales, propagando null (igual criterio que el Python:
// solo suma cuando el valor existe; si nunca hubo valor, queda null).
function sumarOpcional(acumulado, valor) {
  if (valor === null || valor === undefined) return acumulado;
  return Math.round(((acumulado || 0) + valor) * 100) / 100;
}

/**
 * Detecta qué columnas del Excel corresponden al legajo y al nombre, sin parsear datos.
 * Útil para que la UI muestre un picker de columnas cuando la detección automática no
 * reconoce los headers del archivo.
 *
 * @param {Array<Array>} rows — matriz de la hoja (sheet_to_json header:1), solo se usa rows[0]
 * @returns {{ headers: {idx:number, name:string}[], legajoIdx: number, nombreIdx: number }}
 *   legajoIdx / nombreIdx = -1 si no se detectó.
 */
export function detectXlsxColumns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { headers: [], legajoIdx: -1, nombreIdx: -1 };
  }
  const raw = rows[0] || [];
  const headers = raw
    .map((h, i) => ({ idx: i, name: h != null ? String(h).trim() : '' }))
    .filter((h) => h.name !== '');
  return {
    headers,
    legajoIdx: indicePorAliases(raw, _LEGAJO_ALIASES),
    nombreIdx: indicePorAliases(raw, _NOMBRE_ALIASES),
  };
}

// Parser principal.
// rows: Array<Array<any>> — la hoja como matriz fila-por-fila (sheet_to_json header:1).
// opts.colLegajoIdx / opts.colNombreIdx: override del índice de columna (elegido por el usuario
//   en el picker de la UI); -1 o undefined = usar la detección automática por aliases.
// Devuelve { [legajo]: LiquidacionEmpleado } consolidado por legajo.
export function parseLiquidacionXlsx(rows, opts = {}) {
  const resultados = {};
  if (!Array.isArray(rows) || rows.length === 0) return resultados;

  const headers = rows[0] || [];
  const meta = parsearEncabezados(headers);
  // Overrides del picker de columnas de la UI (el usuario eligió manualmente).
  if (opts.colLegajoIdx != null && Number(opts.colLegajoIdx) >= 0) {
    meta.idxEmpleado = Number(opts.colLegajoIdx);
  }
  if (opts.colNombreIdx != null && Number(opts.colNombreIdx) >= 0) {
    meta.idxNombre = Number(opts.colNombreIdx);
  }

  // Acumulador por legajo: junta filas (cada fila = un bloque por fecha de imputación).
  // estado[legajo] = { legajo, nombre, neto, total_contrib, conceptos, n_bloques }
  const estado = {};
  const orden = [];

  for (let r = 1; r < rows.length; r++) {
    const fila = rows[r];
    if (!fila) continue;

    // Saltar filas sin valor en EMPLEADO (filas vacías y fila-total espuria al final).
    const celdaEmp = meta.idxEmpleado >= 0 ? fila[meta.idxEmpleado] : null;
    if (celdaEmp === null || celdaEmp === undefined || celdaEmp === '') continue;
    // Si EMPLEADO no resuelve a un legajo no vacío, también se descarta.
    const legajo = normalizarLegajo(celdaEmp);
    if (legajo === '' ) continue;

    const nombre = meta.idxNombre >= 0
      ? String(fila[meta.idxNombre] === null || fila[meta.idxNombre] === undefined
          ? ''
          : fila[meta.idxNombre]).trim()
      : '';

    // Conceptos de la fila.
    const conceptosFila = [];
    let totalContribFila = null;
    for (const col of meta.columnas) {
      if (col.esUnidad) continue; // excluir unidades/días/porcentajes
      const valor = valorNumerico(fila[col.indice]);
      if (valor === null || valor === 0) continue; // 0/null/'' = no aplica
      const monto = Math.abs(valor);
      const columna = col.lado === 'CONTRIB' ? 'CONTRIB' : 'REM';
      conceptosFila.push({
        codigo: col.codigo,
        descripcion: col.descripcion,
        monto,
        columna,
      });
      if (col.lado === 'CONTRIB') {
        totalContribFila = sumarOpcional(totalContribFila, monto);
      }
    }

    // Neto de la fila.
    const netoFila = meta.idxNeto >= 0 ? valorNumerico(fila[meta.idxNeto]) : null;

    // Acumular en el estado del legajo.
    if (!Object.prototype.hasOwnProperty.call(estado, legajo)) {
      estado[legajo] = {
        legajo,
        nombre,
        neto: null,
        total_contrib: null,
        conceptos: [],
        n_bloques: 0,
      };
      orden.push(legajo);
    }
    const e = estado[legajo];
    if (!e.nombre && nombre) e.nombre = nombre;
    e.neto = sumarOpcional(e.neto, netoFila);
    e.total_contrib = sumarOpcional(e.total_contrib, totalContribFila);
    for (const c of conceptosFila) e.conceptos.push(c);
    e.n_bloques += 1;
  }

  // Materializar a LiquidacionEmpleado (fusionando conceptos por código).
  for (const legajo of orden) {
    const e = estado[legajo];
    resultados[legajo] = {
      legajo: e.legajo,
      nombre: e.nombre,
      // No hay 'Total Haberes' explícito ni total de descuentos en el Excel:
      // no se inventan; el validador maneja null.
      bruto: null,
      neto: e.neto,
      total_rem: null,
      total_desc: null,
      total_no_rem: null,
      total_contrib: e.total_contrib,
      conceptos: fusionarConceptos(e.conceptos),
      n_bloques: e.n_bloques,
      errores_parse: [],
    };
  }

  return resultados;
}
