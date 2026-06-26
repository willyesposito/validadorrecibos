// Logica de validacion cruzada: liquidacion vs recibos.
// Traduccion fiel de src/validador.py a ESM. Sin dependencias de DOM/window:
// importable tanto en Node (ESM) como en navegador (<script type="module">).

// Tolerancia para comparacion de conceptos individuales (±$0.01)
const TOLS_CONCEPTO = 0.01;
// Tolerancia para comparaciones de totales (±$1.00 cubre redondeos acumulados)
const TOL_TOTAL = 1.0;
// Tolerancia para suma del grafico de torta (±1 punto porcentual)
const TOL_TORTA = 1.0;

// Codigos de conceptos de contribucion (validados solo por total, no linea por linea).
// Codigos 6050-6999 y 7015 son contribuciones patronales del encabezado del recibo.
// _CONTRIB_RANGE = range(6050, 7100) en Python => enteros 6050..7099 inclusive.
const _CONTRIB_MIN = 6050;
const _CONTRIB_MAX = 7099; // range(6050, 7100) -> ultimo valor 7099

function _enContribRange(n) {
  return n >= _CONTRIB_MIN && n <= _CONTRIB_MAX;
}

function _is_contrib(codigo) {
  // Replica int(codigo.lstrip('-')) in _CONTRIB_RANGE con manejo de ValueError.
  // lstrip('-') elimina los guiones del inicio; el resto debe ser entero valido.
  const s = String(codigo).replace(/^-+/, '');
  // Python int() acepta espacios alrededor y signo opcional; tras lstrip('-')
  // no quedan guiones iniciales. Reproducimos un parseo estricto de entero.
  const trimmed = s.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return false; // ValueError -> False
  }
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n)) {
    return false;
  }
  return _enContribRange(n);
}

// Formatea un monto al estilo AR '1.234.567,89'. Replica _fmt de Python.
// Devuelve 'N/D' cuando el valor es null/undefined (None en Python).
export function _fmt(v) {
  if (v === null || v === undefined) {
    return 'N/D';
  }
  // Python: f'{v:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
  // f'{v:,.2f}' produce separador de miles ',' y decimal '.', con 2 decimales.
  const usFmt = _formatThousandsUS(v);
  return usFmt.replace(/,/g, 'X').replace(/\./g, ',').replace(/X/g, '.');
}

// Reproduce f'{v:,.2f}' de Python: 2 decimales, separador de miles ',' y
// decimal '.'. Maneja el signo negativo igual que Python (signo al frente).
function _formatThousandsUS(v) {
  const neg = v < 0;
  const abs = Math.abs(v);
  const fixed = abs.toFixed(2); // redondeo a 2 decimales
  const [intPart, decPart] = fixed.split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + withSep + '.' + decPart;
}

// round() de Python (banker's rounding) vs Math.round de JS difieren en .5,
// pero el Python original usa round(x, 2) sobre diferencias de floats donde el
// caso .5 exacto es practicamente inexistente. Replicamos round(x, 2) con un
// redondeo a 2 decimales estandar (suficiente para la logica de tolerancias).
function _round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function _diff_ok(a, b, tol) {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return Math.abs(a - b) <= tol;
}

function _crearResultado({
  legajo = '',
  nombre_liqui = '',
  nombre_recibo = '',
  resultado = 'OK',
  n_bloques_liqui = 1,
  n_paginas_recibo = 1,
} = {}) {
  return {
    legajo,
    nombre_liqui,
    nombre_recibo,
    resultado,
    hallazgos: [],
    n_bloques_liqui,
    n_paginas_recibo,
  };
}

function _crearHallazgo({
  tipo,
  mensaje,
  codigo = '',
  descripcion = '',
  monto_liqui = null,
  monto_recibo = null,
  diferencia = null,
}) {
  return { tipo, mensaje, codigo, descripcion, monto_liqui, monto_recibo, diferencia };
}

function _validar_empleado(liqui, recibo) {
  const resultado = _crearResultado({
    legajo: liqui.legajo,
    nombre_liqui: liqui.nombre,
    nombre_recibo: recibo.nombre,
    n_bloques_liqui: liqui.n_bloques,
    n_paginas_recibo: recibo.n_paginas,
  });
  const hallazgos = resultado.hallazgos;

  // Construir lookup de conceptos del recibo (no-contribucion) por codigo.
  const recibo_conceptos = {};
  for (const c of recibo.conceptos) {
    if (Object.prototype.hasOwnProperty.call(recibo_conceptos, c.codigo)) {
      hallazgos.push(_crearHallazgo({
        tipo: 'CONCEPTO_DUPLICADO',
        mensaje: `Recibo: código ${c.codigo} (${c.descripcion}) duplicado`,
        codigo: c.codigo,
        descripcion: c.descripcion,
      }));
    } else {
      recibo_conceptos[c.codigo] = c;
    }
  }

  // --- 1. Verificar que cada concepto de liquidacion exista en el recibo ---
  for (const c of liqui.conceptos) {
    // Saltear conceptos del rango de contribucion (validados por total).
    // Tambien se saltean los marcados explicitamente columna='CONTRIB': el parser
    // de Excel marca asi las contribuciones/provisiones (a la derecha del NETO),
    // que pueden tener codigos fuera del rango 6050-7099 (ej. provisiones 3570).
    // En la ruta PDF columna es siempre '' => esta condicion no altera su resultado.
    if (_is_contrib(c.codigo) || c.columna === 'CONTRIB') {
      continue;
    }

    const rc = Object.prototype.hasOwnProperty.call(recibo_conceptos, c.codigo)
      ? recibo_conceptos[c.codigo]
      : undefined;
    if (rc === undefined) {
      hallazgos.push(_crearHallazgo({
        tipo: 'CONCEPTO_FALTANTE',
        mensaje: `Código ${c.codigo} (${c.descripcion}) en liquidación [${c.columna}] ` +
          `no encontrado en recibo. Monto: $${_fmt(c.monto)}`,
        codigo: c.codigo,
        descripcion: c.descripcion,
        monto_liqui: c.monto,
      }));
    } else {
      // El recibo muestra los descuentos en negativo y la liquidacion los
      // lista como magnitud. La diferencia de signo es convencion de
      // presentacion, no una diferencia de monto: comparamos por valor absoluto.
      const monto_recibo_abs = Math.abs(rc.monto);
      if (!_diff_ok(c.monto, monto_recibo_abs, TOLS_CONCEPTO)) {
        const diff = _round2(c.monto - monto_recibo_abs);
        hallazgos.push(_crearHallazgo({
          tipo: 'MONTO_DIFIERE',
          mensaje: `Código ${c.codigo} (${c.descripcion}): ` +
            `liquidación $${_fmt(c.monto)} ≠ recibo $${_fmt(monto_recibo_abs)} ` +
            `(dif $${_fmt(diff)})`,
          codigo: c.codigo,
          descripcion: c.descripcion,
          monto_liqui: c.monto,
          monto_recibo: monto_recibo_abs,
          diferencia: diff,
        }));
      }
    }
  }

  // --- 2. Verificar totales ---
  const _check_total = (label, lv, rv) => {
    const lvNull = lv === null || lv === undefined;
    const rvNull = rv === null || rv === undefined;
    if (lvNull && rvNull) {
      return;
    }
    if (lvNull || rvNull) {
      hallazgos.push(_crearHallazgo({
        tipo: 'TOTAL_DIFIERE',
        mensaje: `${label}: liquidación=${_fmt(lv)} recibo=${_fmt(rv)} (uno es N/D)`,
      }));
      return;
    }
    if (!_diff_ok(lv, rv, TOL_TOTAL)) {
      const diff = _round2(lv - rv);
      hallazgos.push(_crearHallazgo({
        tipo: 'TOTAL_DIFIERE',
        mensaje: `${label}: liquidación $${_fmt(lv)} ≠ recibo $${_fmt(rv)} (dif $${_fmt(diff)})`,
        diferencia: diff,
      }));
    }
  };

  _check_total('Neto', liqui.neto, recibo.neto);
  _check_total('Bruto', liqui.bruto, recibo.bruto);
  _check_total('Total Descuentos', liqui.total_desc, recibo.composicion_desc);
  _check_total('Total Contribuciones', liqui.total_contrib, recibo.total_contribuciones);

  // Costo Laboral = Bruto + Contribuciones
  if (recibo.bruto !== null && recibo.bruto !== undefined &&
      recibo.total_contribuciones !== null && recibo.total_contribuciones !== undefined) {
    const costo_calc = _round2(recibo.bruto + recibo.total_contribuciones);
    if (recibo.costo_empleador !== null && recibo.costo_empleador !== undefined &&
        !_diff_ok(costo_calc, recibo.costo_empleador, TOL_TOTAL)) {
      const diff = _round2(costo_calc - recibo.costo_empleador);
      hallazgos.push(_crearHallazgo({
        tipo: 'TOTAL_DIFIERE',
        mensaje: `Costo Laboral recibo: Bruto+Contrib=$${_fmt(costo_calc)} ≠ ` +
          `impreso=$${_fmt(recibo.costo_empleador)} (dif=$${_fmt(diff)})`,
        diferencia: diff,
      }));
    }
  }

  // --- 3. Validacion de suma del grafico de torta (por pagina del recibo) ---
  if (recibo.porcentajes_torta && recibo.porcentajes_torta.length > 0) {
    const total_pct = _round2(recibo.porcentajes_torta.reduce((a, b) => a + b, 0));
    if (Math.abs(total_pct - 100.0) > TOL_TORTA) {
      hallazgos.push(_crearHallazgo({
        tipo: 'TORTA_NO_SUMA',
        mensaje: `Gráfico de torta: suma de porcentajes = ${total_pct}% (esperado ~100%)`,
        diferencia: _round2(total_pct - 100.0),
      }));
    }
  }

  // --- 4. Chequeos de consistencia interna ---
  // Neto = Bruto - Descuentos (del recibo)
  if (recibo.bruto !== null && recibo.bruto !== undefined &&
      recibo.composicion_desc !== null && recibo.composicion_desc !== undefined &&
      recibo.neto !== null && recibo.neto !== undefined) {
    const neto_calc = _round2(recibo.bruto - recibo.composicion_desc);
    if (!_diff_ok(neto_calc, recibo.neto, TOL_TOTAL)) {
      const diff = _round2(neto_calc - recibo.neto);
      hallazgos.push(_crearHallazgo({
        tipo: 'TOTAL_DIFIERE',
        mensaje: `Recibo: Bruto-Desc=$${_fmt(neto_calc)} ≠ Neto impreso=$${_fmt(recibo.neto)} ` +
          `(dif=$${_fmt(diff)})`,
        diferencia: diff,
      }));
    }
  }

  // Determinar nivel de resultado general
  const errores = hallazgos.filter((h) => h.tipo !== 'TORTA_NO_SUMA');
  const advertencias = hallazgos.filter((h) => h.tipo === 'TORTA_NO_SUMA');

  if (errores.length > 0) {
    resultado.resultado = 'ERROR';
  } else if (advertencias.length > 0) {
    resultado.resultado = 'ADVERTENCIA';
  } else {
    resultado.resultado = 'OK';
  }

  return resultado;
}

// Ordena claves replicando Python sorted() sobre strings (orden por punto de
// codigo Unicode, ascendente). Array.prototype.sort por defecto compara strings
// de la misma forma (lexicografico por unidades UTF-16); para los legajos
// (digitos/ascii) coincide con el orden de Python.
function _sortedUnion(liquidaciones, recibos) {
  const set = new Set([...Object.keys(liquidaciones), ...Object.keys(recibos)]);
  return Array.from(set).sort();
}

export function validar(liquidaciones, recibos) {
  // Ejecuta la validacion completa. Devuelve el objeto reporte listo para serializar.
  const resultados = [];

  const all_legajos = _sortedUnion(liquidaciones, recibos);

  for (const legajo of all_legajos) {
    const liqui = Object.prototype.hasOwnProperty.call(liquidaciones, legajo)
      ? liquidaciones[legajo]
      : undefined;
    const recibo = Object.prototype.hasOwnProperty.call(recibos, legajo)
      ? recibos[legajo]
      : undefined;

    if (liqui === undefined || liqui === null) {
      // Recibo sin par en liquidacion
      const r = _crearResultado({
        legajo,
        nombre_recibo: recibo ? recibo.nombre : '',
        resultado: 'SIN_PAR',
      });
      r.hallazgos.push(_crearHallazgo({
        tipo: 'LEGAJO_SIN_PAR',
        mensaje: `Legajo ${legajo} tiene recibo pero no aparece en la liquidación`,
      }));
      resultados.push(r);
      continue;
    }

    if (recibo === undefined || recibo === null) {
      const r = _crearResultado({
        legajo,
        nombre_liqui: liqui.nombre,
        resultado: 'SIN_PAR',
      });
      r.hallazgos.push(_crearHallazgo({
        tipo: 'LEGAJO_SIN_PAR',
        mensaje: `Legajo ${legajo} aparece en liquidación pero no tiene recibo`,
      }));
      resultados.push(r);
      continue;
    }

    const r = _validar_empleado(liqui, recibo);
    resultados.push(r);
  }

  // --- Resumen ---
  const n_ok = resultados.filter((r) => r.resultado === 'OK').length;
  const n_error = resultados.filter((r) => r.resultado === 'ERROR').length;
  const n_adv = resultados.filter((r) => r.resultado === 'ADVERTENCIA').length;
  const n_sin_par = resultados.filter((r) => r.resultado === 'SIN_PAR').length;

  const reporte = {
    resumen: {
      // total = empleados distintos en el reporte (union de legajos liqui ∪ recibos)
      total: resultados.length,
      total_empleados_liqui: Object.keys(liquidaciones).length,
      total_empleados_recibos: Object.keys(recibos).length,
      ok: n_ok,
      errores: n_error,
      advertencias: n_adv,
      sin_par: n_sin_par,
    },
    empleados: resultados.map((r) => _resultado_to_dict(r)),
  };

  return reporte;
}

function _resultado_to_dict(r) {
  return {
    legajo: r.legajo,
    nombre_liqui: r.nombre_liqui,
    nombre_recibo: r.nombre_recibo,
    resultado: r.resultado,
    n_bloques_liqui: r.n_bloques_liqui,
    n_paginas_recibo: r.n_paginas_recibo,
    hallazgos: r.hallazgos.map((h) => ({
      tipo: h.tipo,
      mensaje: h.mensaje,
      codigo: h.codigo,
      descripcion: h.descripcion,
      monto_liqui: h.monto_liqui,
      monto_recibo: h.monto_recibo,
      diferencia: h.diferencia,
    })),
  };
}
