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

// ── Landmarks de las AGRUPACIONES de totales (por posición de columna) ──
// El Excel ordena los conceptos en bloques contiguos. Cada total es la suma de un
// bloque, delimitado por códigos/encabezados ancla:
//   • BRUTO:          desde el primer concepto cuyo código ∈ {1000,1001,1002,1003}
//                     hasta el anterior al 5010.
//   • DESCUENTOS:     desde el 5010 (inclusive) hasta el anterior al NETO.
//   • CONTRIBUCIONES: desde el siguiente al NETO hasta el anterior a TARIFA.
// Si un ancla no aparece, el bloque queda vacío y la UI deja elegir los conceptos a mano.
const _BRUTO_START_CODES = ['1000', '1001', '1002', '1003'];
const _DESC_START_CODE = '5010';
const _CONTRIB_END_HEADER = 'TARIFA';

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
// opts.idxNeto: override del índice de la columna NETO (elegido en el picker de la UI);
//   -1/undefined = detectar por header 'NETO'.
// Devuelve { idxEmpleado, idxNombre, idxNeto, columnas, landmarks }.
//   columnas: [{indice, codigo, descripcion, lado:'EMPLEADO'|'CONTRIB', esUnidad,
//               grupo:'bruto'|'desc'|'contrib'|null, signo}]
//   landmarks: { brutoStart, descStart, neto:boolean, contribEnd } — qué anclas se detectaron.
function parsearEncabezados(headers, opts = {}) {
  const idxEmpleado = indicePorAliases(headers, _LEGAJO_ALIASES);
  const idxNombre = indicePorAliases(headers, _NOMBRE_ALIASES);
  let idxNeto = indicePorHeader(headers, 'NETO');
  if (opts.idxNeto != null && Number(opts.idxNeto) >= 0) idxNeto = Number(opts.idxNeto);

  // 1) Columnas de concepto (patrón 'CODIGO - DESCRIPCION', con o sin espacios).
  const columnas = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h === null || h === undefined) continue;
    const txt = String(h).trim();
    if (!txt) continue;
    if (i === idxNeto) continue; // la columna NETO no es un concepto; se trata aparte
    const guion = txt.indexOf('-');
    if (guion <= 0) continue; // sin guión, o guión al inicio => no es concepto
    // trim() tolera tanto '1003-SUELDO' como '1003 - SUELDO' (variantes de Meta 4).
    const codigo = txt.slice(0, guion).trim();
    const descripcion = txt.slice(guion + 1).trim();
    // Solo aceptar como concepto si el código es numérico (evita falsos positivos).
    if (!/^\d+$/.test(codigo)) continue;
    columnas.push({ indice: i, codigo, descripcion, lado: null, esUnidad: false, grupo: null, signo: 1 });
  }

  // 2) Landmarks de agrupación (posición de columna en la hoja).
  const idxTarifa = indicePorHeader(headers, _CONTRIB_END_HEADER); // -1 si no está
  const contribEndIdx = idxTarifa >= 0 ? idxTarifa : Infinity;
  let brutoStartIdx = -1, brutoStartCode = null;
  for (const c of columnas) {
    if (_BRUTO_START_CODES.indexOf(c.codigo) !== -1) { brutoStartIdx = c.indice; brutoStartCode = c.codigo; break; }
  }
  let descStartIdx = -1;
  for (const c of columnas) {
    if (c.codigo === _DESC_START_CODE) { descStartIdx = c.indice; break; }
  }

  // 3) Asignar lado / esUnidad / grupo a cada columna según su posición.
  for (const c of columnas) {
    const i = c.indice;
    const enContrib = idxNeto >= 0 && i > idxNeto && i < contribEndIdx;
    c.lado = enContrib ? 'CONTRIB' : 'EMPLEADO';
    // Solo el lado EMPLEADO puede ser una unidad (días/porcentajes); CONTRIB siempre es monto.
    c.esUnidad = c.lado === 'EMPLEADO' && esColumnaUnidad(c.codigo, c.descripcion);
    if (enContrib) {
      c.grupo = 'contrib';
    } else if (idxNeto < 0 || i < idxNeto) {
      if (descStartIdx >= 0 && i >= descStartIdx) {
        c.grupo = 'desc';
      } else if (brutoStartIdx >= 0 && i >= brutoStartIdx && (descStartIdx < 0 || i < descStartIdx)) {
        c.grupo = 'bruto';
      } else {
        c.grupo = null;
      }
    } else {
      c.grupo = null;
    }
  }

  const landmarks = {
    brutoStart: brutoStartCode,                       // código que ancló el inicio de bruto, o null
    descStart: descStartIdx >= 0 ? _DESC_START_CODE : null,
    neto: idxNeto >= 0,
    contribEnd: idxTarifa >= 0 ? _CONTRIB_END_HEADER : null,
  };

  return { idxEmpleado, idxNombre, idxNeto, columnas, landmarks };
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
 * @returns {{ headers: {idx:number, name:string}[], legajoIdx, nombreIdx, netoIdx }}
 *   índices = -1 si no se detectó la columna.
 */
export function detectXlsxColumns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { headers: [], legajoIdx: -1, nombreIdx: -1, netoIdx: -1 };
  }
  const raw = rows[0] || [];
  const headers = raw
    .map((h, i) => ({ idx: i, name: h != null ? String(h).trim() : '' }))
    .filter((h) => h.name !== '');
  return {
    headers,
    legajoIdx: indicePorAliases(raw, _LEGAJO_ALIASES),
    nombreIdx: indicePorAliases(raw, _NOMBRE_ALIASES),
    netoIdx: indicePorHeader(raw, 'NETO'),
  };
}

/**
 * Detecta las AGRUPACIONES de totales (bruto / descuentos / contribuciones) sin parsear
 * datos: devuelve los conceptos asignados a cada total por las reglas de posición, para que
 * la UI los muestre y permita editarlos (sumar / restar / eliminar / agregar). Excluye las
 * columnas de unidad (días/porcentajes), que no son montos.
 *
 * @param {Array<Array>} rows — matriz de la hoja (sheet_to_json header:1)
 * @param {{ idxNeto?: number }} opts — override del índice de NETO (del picker de la UI)
 * @returns {{
 *   bruto: {codigo,descripcion,signo}[], desc: {...}[], contrib: {...}[],
 *   todos: {codigo,descripcion,grupo}[],
 *   landmarks: { brutoStart, descStart, neto:boolean, contribEnd }
 * }}
 */
export function detectXlsxGroups(rows, opts = {}) {
  const vacio = { bruto: [], desc: [], contrib: [], todos: [],
    landmarks: { brutoStart: null, descStart: null, neto: false, contribEnd: null } };
  if (!Array.isArray(rows) || rows.length === 0) return vacio;
  const meta = parsearEncabezados(rows[0] || [], { idxNeto: opts.idxNeto });
  // Las agrupaciones por defecto excluyen las columnas de unidad (días/porcentajes).
  const mk = (c) => ({ codigo: c.codigo, descripcion: c.descripcion, signo: 1 });
  const enGrupo = (g) => meta.columnas.filter((c) => c.grupo === g && !c.esUnidad).map(mk);
  return {
    bruto: enGrupo('bruto'),
    desc: enGrupo('desc'),
    contrib: enGrupo('contrib'),
    // 'todos' incluye TODAS las columnas de concepto (incluso las marcadas como unidad), para
    // que la UI pueda agregar una columna mal clasificada (ej. 4453 DIAS_FERIADOS, que es monto).
    todos: meta.columnas.map((c) => ({
      codigo: c.codigo, descripcion: c.descripcion, grupo: c.esUnidad ? null : c.grupo, esUnidad: c.esUnidad,
    })),
    landmarks: meta.landmarks,
  };
}

// Construye un mapa de override de agrupaciones a partir de opts.grupos.
// opts.grupos = { bruto: {codigo:signo,...}, desc:{...}, contrib:{...} } (lo arma la UI).
// Devuelve { [codigo]: {grupo, signo} } o null si no hay override.
function construirOverrideGrupos(grupos) {
  if (!grupos) return null;
  const map = {};
  for (const grupo of ['bruto', 'desc', 'contrib']) {
    const m = grupos[grupo] || {};
    for (const codigo of Object.keys(m)) {
      const signo = Number(m[codigo]);
      map[codigo] = { grupo, signo: signo === -1 ? -1 : 1 };
    }
  }
  return map;
}

// Parser principal.
// rows: Array<Array<any>> — la hoja como matriz fila-por-fila (sheet_to_json header:1).
// opts.colLegajoIdx / opts.colNombreIdx / opts.colNetoIdx: override del índice de columna
//   (elegido en el picker de la UI); -1/undefined = detección automática.
// opts.grupos: override de las agrupaciones de totales (ver construirOverrideGrupos); si se
//   provee, define qué conceptos y con qué signo suman a bruto/desc/contrib. Sin override,
//   se usan las agrupaciones automáticas por posición (landmarks).
// Devuelve { [legajo]: LiquidacionEmpleado } consolidado por legajo.
export function parseLiquidacionXlsx(rows, opts = {}) {
  const resultados = {};
  if (!Array.isArray(rows) || rows.length === 0) return resultados;

  const headers = rows[0] || [];
  const meta = parsearEncabezados(headers, { idxNeto: opts.colNetoIdx });
  // Overrides del picker de columnas de la UI (el usuario eligió manualmente).
  if (opts.colLegajoIdx != null && Number(opts.colLegajoIdx) >= 0) {
    meta.idxEmpleado = Number(opts.colLegajoIdx);
  }
  if (opts.colNombreIdx != null && Number(opts.colNombreIdx) >= 0) {
    meta.idxNombre = Number(opts.colNombreIdx);
  }
  const overrideGrupos = construirOverrideGrupos(opts.grupos);

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

    // Conceptos de la fila + totales por agrupación.
    const conceptosFila = [];
    let brutoFila = null, descFila = null, contribFila = null;
    for (const col of meta.columnas) {
      // Grupo + signo efectivos: override de la UI si existe, si no la asignación automática.
      let grupo = col.grupo, signo = col.signo || 1;
      const o = overrideGrupos ? overrideGrupos[col.codigo] : undefined;
      if (overrideGrupos) {
        grupo = o ? o.grupo : null;   // con override, un código no listado no suma a ningún total
        signo = o ? o.signo : 1;
      }
      // Las columnas de unidad (días/porcentajes) se ignoran por defecto. Solo cuentan si el
      // usuario las asignó explícitamente a un grupo (override): en ese caso declara que esa
      // columna es un monto (ej. 4453 DIAS_FERIADOS, que la heurística confunde con unidad).
      const asignadaAGrupo = !!(o && o.grupo);
      if (col.esUnidad && !asignadaAGrupo) continue;

      const valor = valorNumerico(fila[col.indice]);
      if (valor === null || valor === 0) continue; // 0/null/'' = no aplica
      const monto = Math.abs(valor);
      // Los conceptos de contribución se validan solo por total (el validador los saltea
      // línea por línea vía columna==='CONTRIB'). El resto se chequea concepto a concepto.
      const columna = grupo === 'contrib' ? 'CONTRIB' : 'REM';
      conceptosFila.push({ codigo: col.codigo, descripcion: col.descripcion, monto, columna });
      if (grupo === 'bruto')   brutoFila   = sumarOpcional(brutoFila,   signo * monto);
      if (grupo === 'desc')    descFila    = sumarOpcional(descFila,    signo * monto);
      if (grupo === 'contrib') contribFila = sumarOpcional(contribFila, signo * monto);
    }

    // Neto de la fila.
    const netoFila = meta.idxNeto >= 0 ? valorNumerico(fila[meta.idxNeto]) : null;

    // Acumular en el estado del legajo.
    if (!Object.prototype.hasOwnProperty.call(estado, legajo)) {
      estado[legajo] = {
        legajo,
        nombre,
        bruto: null,
        neto: null,
        total_desc: null,
        total_contrib: null,
        conceptos: [],
        n_bloques: 0,
      };
      orden.push(legajo);
    }
    const e = estado[legajo];
    if (!e.nombre && nombre) e.nombre = nombre;
    e.bruto = sumarOpcional(e.bruto, brutoFila);
    e.neto = sumarOpcional(e.neto, netoFila);
    e.total_desc = sumarOpcional(e.total_desc, descFila);
    e.total_contrib = sumarOpcional(e.total_contrib, contribFila);
    for (const c of conceptosFila) e.conceptos.push(c);
    e.n_bloques += 1;
  }

  // Materializar a LiquidacionEmpleado (fusionando conceptos por código).
  for (const legajo of orden) {
    const e = estado[legajo];
    resultados[legajo] = {
      legajo: e.legajo,
      nombre: e.nombre,
      // bruto / total_desc / total_contrib se calculan sumando las agrupaciones de
      // conceptos (ver parsearEncabezados → landmarks). Si una agrupación quedó vacía
      // (ancla no detectada y sin override del usuario), su total queda null.
      bruto: e.bruto,
      neto: e.neto,
      total_rem: null,
      total_desc: e.total_desc,
      total_no_rem: null,
      total_contrib: e.total_contrib,
      conceptos: fusionarConceptos(e.conceptos),
      n_bloques: e.n_bloques,
      errores_parse: [],
    };
  }

  return resultados;
}
