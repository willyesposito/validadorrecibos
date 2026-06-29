// app.js — Orquestación en el navegador: carga de archivos → extracción → parseo
// → validación → reporte interactivo. Todo client-side; nada se sube a internet.
//
// Rediseño orientado a REVISIÓN (multi-cliente, 1 a la vez): tras validar, la zona
// de carga se colapsa, se prioriza el filtro de errores, los KPIs funcionan como
// filtros y se puede exportar las diferencias a CSV. Los parsers y el validador
// (core/validador.js) no se tocan: esto es solo la capa de UI.

import { extractPagesText } from './parsers/pdf-extract.js';
import { parseRecibos } from './parsers/parser-recibos.js';
import { parseLiquidacionPdf } from './parsers/parser-liquidacion-pdf.js';
import { parseLiquidacionXlsx, detectXlsxColumns, detectXlsxGroups } from './parsers/parser-liquidacion-xlsx.js';
import { validar } from './core/validador.js';

// pdf.js viene del <script> vendoreado (global pdfjsLib). Worker self-hosted.
const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

// ─────────────── Estado de archivos ───────────────
// liqui y recibos son ambos arrays: se admiten varios archivos por lado y se cruzan
// contra un conjunto unificado (consolidado por legajo). Útil cuando hay anexos /
// confidenciales que se agregan aparte y deben sumarse a la liquidación principal.
const state = {
  liqui: [], recibos: [],
  // Índices de columna del Excel elegidos por el usuario (-1 = usar detección automática).
  xlsxColLegajoIdx: -1,
  xlsxColNombreIdx: -1,
  xlsxColNetoIdx: -1,
  // Agrupaciones de totales editables: { bruto:[{codigo,descripcion,signo}], desc:[...], contrib:[...] }
  xlsxGrupos: null,
  // Pool de todos los conceptos del Excel (para el control "agregar"): [{codigo,descripcion,grupo,esUnidad}]
  xlsxTodos: [],
  // Filas de encabezado del primer Excel (cache para re-detectar agrupaciones sin releer el archivo).
  xlsxHeaderRows: null,
};

const $ = (id) => document.getElementById(id);
const ui = {
  inLiqui: $('in-liqui'), inRecibos: $('in-recibos'),
  dzLiqui: $('dz-liqui'), dzRecibos: $('dz-recibos'),
  filesLiqui: $('files-liqui'), filesRecibos: $('files-recibos'),
  btnValidar: $('btn-validar'), btnReset: $('btn-reset'), btnCambiar: $('btn-cambiar'),
  xlsxCfg: $('xlsx-cfg'),
  xlsxColLegajo: $('xlsx-col-legajo'), xlsxColLegajoBadge: $('xlsx-col-legajo-badge'),
  xlsxColNombre: $('xlsx-col-nombre'), xlsxColNombreBadge: $('xlsx-col-nombre-badge'),
  xlsxColNeto: $('xlsx-col-neto'), xlsxColNetoBadge: $('xlsx-col-neto-badge'),
  xlsxCfgHint: $('xlsx-cfg-hint'),
  xlsxGrupos: $('xlsx-grupos'), xgGroups: $('xg-groups'),
  secCarga: $('sec-carga'), rbFiles: $('rb-files'), rbCount: $('rb-count'),
  progress: $('progress'), ptxt: $('ptxt'),
  errbanner: $('errbanner'), errtext: $('errtext'),
  results: $('results'), verdict: $('verdict'), runctx: $('runctx'),
  chipSinpar: $('chip-sinpar'), btnExport: $('btn-export'),
  inCliente: $('in-cliente'), rbCliente: $('rb-cliente'),
};

// Nombre del cliente que se está procesando (campo del hero). Se usa en el
// contexto de la corrida, la barra compacta y el nombre del CSV exportado.
function clientName() { return (ui.inCliente.value || '').trim(); }

function refreshButton() {
  ui.btnValidar.disabled = !(state.liqui.length > 0 && state.recibos.length > 0);
}

function setLiqui(files) {
  state.liqui = Array.from(files || []);
  if (state.liqui.length) {
    const names = state.liqui.map((f) => f.name);
    ui.filesLiqui.textContent = state.liqui.length === 1
      ? '✓ ' + names[0]
      : `✓ ${state.liqui.length} archivos: ${names.join(', ')}`;
    ui.dzLiqui.classList.add('filled');
  } else {
    ui.filesLiqui.textContent = '';
    ui.dzLiqui.classList.remove('filled');
  }
  refreshButton();
  detectXlsxConfig(); // async — actualiza el panel de columnas si hay un Excel
}

function setRecibos(files) {
  state.recibos = Array.from(files || []);
  if (state.recibos.length) {
    const names = state.recibos.map((f) => f.name);
    ui.filesRecibos.textContent = state.recibos.length === 1
      ? '✓ ' + names[0]
      : `✓ ${state.recibos.length} archivos: ${names.join(', ')}`;
    ui.dzRecibos.classList.add('filled');
  } else {
    ui.filesRecibos.textContent = '';
    ui.dzRecibos.classList.remove('filled');
  }
  refreshButton();
}

// ─────────────── Drag & drop + click ───────────────
function wireDropzone(dz, input, onFiles, multiple) {
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove('drag');
  }));
  dz.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length) onFiles(multiple ? files : files[0]);
  });
  input.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) onFiles(multiple ? files : files[0]);
  });
}
wireDropzone(ui.dzLiqui, ui.inLiqui, setLiqui, true);
wireDropzone(ui.dzRecibos, ui.inRecibos, setRecibos, true);

// "Nueva validación": limpia todo y vuelve al estado inicial (cambiar de cliente).
ui.btnReset.addEventListener('click', () => {
  state.liqui = []; state.recibos = [];
  ocultarXlsxPaneles();
  ui.inLiqui.value = ''; ui.inRecibos.value = ''; ui.inCliente.value = '';
  setLiqui([]); setRecibos([]);
  ui.results.classList.remove('show');
  ui.errbanner.classList.remove('show');
  ui.secCarga.classList.remove('collapsed');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// "Cambiar archivos": re-expande la zona de carga conservando el resultado actual
// hasta que se vuelva a validar.
ui.btnCambiar.addEventListener('click', () => {
  ui.secCarga.classList.remove('collapsed');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ─────────────── Picker de columnas Excel ───────────────
// Detecta qué columna del primer Excel cargado contiene legajo / nombre / neto, y las
// agrupaciones de totales. Actualiza los paneles si hay al menos un .xlsx en state.liqui.
function ocultarXlsxPaneles() {
  ui.xlsxCfg.hidden = true;
  ui.xlsxGrupos.hidden = true;
  state.xlsxColLegajoIdx = -1; state.xlsxColNombreIdx = -1; state.xlsxColNetoIdx = -1;
  state.xlsxGrupos = null; state.xlsxTodos = []; state.xlsxHeaderRows = null;
}

async function detectXlsxConfig() {
  const xlsxFile = state.liqui.find((f) => /\.(xlsx|xls)$/i.test(f.name));
  if (!xlsxFile) { ocultarXlsxPaneles(); return; }
  try {
    const buf = await xlsxFile.arrayBuffer();
    // sheetRows:2 lee solo la fila de encabezados → detección rápida sin parsear datos.
    const wb = window.XLSX.read(new Uint8Array(buf), { type: 'array', sheetRows: 2 });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
    state.xlsxHeaderRows = rows;
    const { headers, legajoIdx, nombreIdx, netoIdx } = detectXlsxColumns(rows);

    // Construir opciones del <select>: "— sin usar —" + una opción por columna.
    const makeOptions = (selIdx) => {
      const opt0 = `<option value="-1">— sin usar —</option>`;
      return opt0 + headers.map((h) =>
        `<option value="${h.idx}"${h.idx === selIdx ? ' selected' : ''}>${esc(h.name)}</option>`
      ).join('');
    };
    ui.xlsxColLegajo.innerHTML = makeOptions(legajoIdx);
    ui.xlsxColNombre.innerHTML = makeOptions(nombreIdx);
    ui.xlsxColNeto.innerHTML = makeOptions(netoIdx);
    state.xlsxColLegajoIdx = legajoIdx;
    state.xlsxColNombreIdx = nombreIdx;
    state.xlsxColNetoIdx = netoIdx;

    const setBadge = (el, idx) => {
      if (idx >= 0) { el.textContent = 'detectado'; el.className = 'xlsx-cfg-badge ok'; }
      else          { el.textContent = 'no detectado'; el.className = 'xlsx-cfg-badge warn'; }
    };
    setBadge(ui.xlsxColLegajoBadge, legajoIdx);
    setBadge(ui.xlsxColNombreBadge, nombreIdx);
    setBadge(ui.xlsxColNetoBadge, netoIdx);

    const hasWarn = legajoIdx < 0 || nombreIdx < 0;
    ui.xlsxCfgHint.textContent = hasWarn
      ? 'Seleccioná manualmente las columnas sin detectar.'
      : 'Columnas detectadas automáticamente — modificalas si es necesario.';

    ui.xlsxCfg.hidden = false;
    refreshGrupos(); // (re)detecta las agrupaciones de totales y las renderiza
  } catch {
    ocultarXlsxPaneles();
  }
}

// Cuando el usuario cambia una columna manualmente, actualizar estado y badge.
function onXlsxColChange(select, badgeEl, stateKey) {
  const idx = parseInt(select.value, 10);
  state[stateKey] = idx;
  badgeEl.textContent = 'modificado';
  badgeEl.className = 'xlsx-cfg-badge mod';
}
ui.xlsxColLegajo.addEventListener('change', () =>
  onXlsxColChange(ui.xlsxColLegajo, ui.xlsxColLegajoBadge, 'xlsxColLegajoIdx'));
ui.xlsxColNombre.addEventListener('change', () =>
  onXlsxColChange(ui.xlsxColNombre, ui.xlsxColNombreBadge, 'xlsxColNombreIdx'));
// Cambiar la columna NETO mueve el punto de corte entre descuentos y contribuciones,
// así que se vuelven a detectar las agrupaciones (descarta ediciones manuales previas).
ui.xlsxColNeto.addEventListener('change', () => {
  onXlsxColChange(ui.xlsxColNeto, ui.xlsxColNetoBadge, 'xlsxColNetoIdx');
  refreshGrupos();
});

// ─────────────── Editor de agrupaciones de totales ───────────────
const XG_DEFS = [
  { key: 'bruto',   label: 'Bruto',                landmark: 'brutoStart', noDetectado: 'No se detectó el inicio del Bruto (códigos 1000–1003). Agregá los conceptos a mano.' },
  { key: 'desc',    label: 'Total Descuentos',     landmark: 'descStart',  noDetectado: 'No se detectó el inicio de Descuentos (código 5010). Agregá los conceptos a mano.' },
  { key: 'contrib', label: 'Total Contribuciones', landmark: 'contribEnd', noDetectado: 'No se detectó NETO o TARIFA. Revisá la columna NETO arriba o agregá los conceptos a mano.' },
];
let XG_LANDMARKS = { brutoStart: null, descStart: null, neto: false, contribEnd: null };

// (Re)detecta las agrupaciones desde los encabezados cacheados y las renderiza.
function refreshGrupos() {
  if (!state.xlsxHeaderRows) { ui.xlsxGrupos.hidden = true; return; }
  const idxNeto = state.xlsxColNetoIdx >= 0 ? state.xlsxColNetoIdx : undefined;
  const g = detectXlsxGroups(state.xlsxHeaderRows, { idxNeto });
  state.xlsxGrupos = { bruto: g.bruto, desc: g.desc, contrib: g.contrib };
  state.xlsxTodos = g.todos;
  XG_LANDMARKS = g.landmarks;
  ui.xlsxGrupos.hidden = false;
  renderGrupos();
}

// Devuelve la descripción de un código desde el pool (para el chip al agregar).
function descDeCodigo(codigo) {
  const t = state.xlsxTodos.find((c) => c.codigo === codigo);
  return t ? t.descripcion : '';
}
function esUnidadCodigo(codigo) {
  const t = state.xlsxTodos.find((c) => c.codigo === codigo);
  return !!(t && t.esUnidad);
}

function renderGrupos() {
  if (!state.xlsxGrupos) { ui.xgGroups.innerHTML = ''; return; }
  ui.xgGroups.innerHTML = XG_DEFS.map((def) => {
    const items = state.xlsxGrupos[def.key] || [];
    const detectado = !!XG_LANDMARKS[def.landmark];
    const warn = (!detectado && items.length === 0)
      ? `<div class="xg-warn">${esc(def.noDetectado)}</div>` : '';
    const chips = items.length
      ? items.map((c) => {
          const neg = c.signo === -1;
          const unidad = esUnidadCodigo(c.codigo) ? '<span class="xg-unit" title="La heurística la marcó como unidad">unidad</span>' : '';
          return `<span class="xg-chip${neg ? ' neg' : ''}" data-g="${def.key}" data-c="${esc(c.codigo)}">
            <button class="xg-sign" title="Sumar (+) o restar (−)" aria-label="Cambiar signo">${neg ? '−' : '+'}</button>
            <span class="xg-code">${esc(c.codigo)}</span>
            <span class="xg-desc" title="${esc(c.descripcion)}">${esc(c.descripcion || '—')}</span>
            ${unidad}
            <button class="xg-rm" title="Quitar de este total" aria-label="Quitar">×</button>
          </span>`;
        }).join('')
      : `<div class="xg-empty">Sin conceptos. Agregá con el menú de abajo.</div>`;
    // Pool para "agregar": conceptos no presentes en este grupo.
    const presentes = new Set(items.map((c) => c.codigo));
    const opts = state.xlsxTodos
      .filter((c) => !presentes.has(c.codigo))
      .map((c) => `<option value="${esc(c.codigo)}">${esc(c.codigo)} · ${esc(c.descripcion || '—')}${c.esUnidad ? ' (unidad)' : ''}</option>`)
      .join('');
    return `<div class="xg-group">
      <div class="xg-g-hd"><span class="xg-g-title">${esc(def.label)}</span><span class="xg-g-count">${items.length} conc.</span></div>
      ${warn}
      <div class="xg-chips">${chips}</div>
      <select class="xg-add" data-g="${def.key}"><option value="">+ agregar concepto…</option>${opts}</select>
    </div>`;
  }).join('');

  // Wire de eventos (delegados por re-render en cada cambio).
  ui.xgGroups.querySelectorAll('.xg-sign').forEach((b) => b.addEventListener('click', () => {
    const chip = b.closest('.xg-chip');
    toggleSigno(chip.dataset.g, chip.dataset.c);
  }));
  ui.xgGroups.querySelectorAll('.xg-rm').forEach((b) => b.addEventListener('click', () => {
    const chip = b.closest('.xg-chip');
    quitarConcepto(chip.dataset.g, chip.dataset.c);
  }));
  ui.xgGroups.querySelectorAll('.xg-add').forEach((s) => s.addEventListener('change', () => {
    if (s.value) agregarConcepto(s.dataset.g, s.value);
  }));
}

function toggleSigno(grupo, codigo) {
  const c = (state.xlsxGrupos[grupo] || []).find((x) => x.codigo === codigo);
  if (c) { c.signo = c.signo === -1 ? 1 : -1; renderGrupos(); }
}
function quitarConcepto(grupo, codigo) {
  state.xlsxGrupos[grupo] = (state.xlsxGrupos[grupo] || []).filter((x) => x.codigo !== codigo);
  renderGrupos();
}
function agregarConcepto(grupo, codigo) {
  const lista = state.xlsxGrupos[grupo] || (state.xlsxGrupos[grupo] = []);
  if (!lista.some((x) => x.codigo === codigo)) {
    lista.push({ codigo, descripcion: descDeCodigo(codigo), signo: 1 });
  }
  renderGrupos();
}

// Construye opts.grupos para el parser desde el estado editable.
function gruposParaParser() {
  if (!state.xlsxGrupos) return undefined;
  const out = {};
  for (const k of ['bruto', 'desc', 'contrib']) {
    out[k] = Object.fromEntries((state.xlsxGrupos[k] || []).map((c) => [c.codigo, c.signo]));
  }
  return out;
}

// ─────────────── Helpers de progreso / error ───────────────
function showProgress(msg) { ui.ptxt.innerHTML = msg; ui.progress.classList.add('show'); }
function hideProgress() { ui.progress.classList.remove('show'); }
function showError(msg) { ui.errtext.innerHTML = msg; ui.errbanner.classList.add('show'); }
function clearError() { ui.errbanner.classList.remove('show'); }
const yield_ = () => new Promise((r) => setTimeout(r, 0));

// ─────────────── Pipeline de validación ───────────────
ui.btnValidar.addEventListener('click', async () => {
  clearError();
  ui.results.classList.remove('show');
  ui.btnValidar.disabled = true;
  try {
    // 1. Liquidación (uno o varios archivos; PDF y/o Excel, mezclables)
    const liquiMaps = [];     // mapas {legajo: emp} parciales a fusionar
    const pdfLiquiPages = []; // páginas de TODOS los PDF de liqui (van juntos al parser)
    const nL = state.liqui.length;
    for (let i = 0; i < nL; i++) {
      const f = state.liqui[i];
      const name = f.name.toLowerCase();
      if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        showProgress(`Leyendo liquidación (Excel ${i + 1}/${nL}: ${f.name})…`);
        await yield_();
        const buf = await f.arrayBuffer();
        const wb = window.XLSX.read(new Uint8Array(buf), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
        liquiMaps.push(parseLiquidacionXlsx(rows, {
          colLegajoIdx: state.xlsxColLegajoIdx >= 0 ? state.xlsxColLegajoIdx : undefined,
          colNombreIdx: state.xlsxColNombreIdx >= 0 ? state.xlsxColNombreIdx : undefined,
          colNetoIdx: state.xlsxColNetoIdx >= 0 ? state.xlsxColNetoIdx : undefined,
          grupos: gruposParaParser(),
        }));
      } else {
        const buf = await f.arrayBuffer();
        const pages = await extractPagesText(new Uint8Array(buf), pdfjsLib,
          (n, t) => showProgress(`Leyendo liquidación (PDF ${i + 1}/${nL}: ${f.name})… página <b>${n}/${t}</b>`));
        pdfLiquiPages.push(pages);
      }
    }
    // Todos los PDF se parsean juntos (el parser consolida cada archivo como una "parte").
    if (pdfLiquiPages.length) liquiMaps.push(parseLiquidacionPdf(pdfLiquiPages));
    const liqui = mergeLiquiMaps(liquiMaps);
    await yield_();

    // 2. Recibos (uno o varios PDF)
    const pagesByFile = [];
    for (let i = 0; i < state.recibos.length; i++) {
      const f = state.recibos[i];
      const buf = await f.arrayBuffer();
      const pages = await extractPagesText(new Uint8Array(buf), pdfjsLib,
        (n, t) => showProgress(`Leyendo recibos (${i + 1}/${state.recibos.length}: ${f.name})… página <b>${n}/${t}</b>`));
      pagesByFile.push(pages);
    }
    const recibos = parseRecibos(pagesByFile);
    await yield_();

    // 3. Validar + enriquecer
    showProgress('Validando…');
    await yield_();
    const reporte = validar(liqui, recibos);
    enrich(reporte, liqui, recibos);

    hideProgress();
    if (reporte.empleados.length === 0) {
      showError('No se detectaron empleados. Verificá que los archivos sean los correctos (liquidación y recibos del mismo período).');
      ui.btnValidar.disabled = false;
      return;
    }
    render(reporte);
    ui.results.classList.add('show');
    ui.secCarga.classList.add('collapsed');
    fillRunbar(reporte);
    const top = ui.results.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top, behavior: 'smooth' });
  } catch (err) {
    hideProgress();
    console.error(err);
    showError(`<b>Error procesando los archivos:</b> ${err && err.message ? err.message : err}. ` +
      `Revisá que la liquidación y los recibos sean PDFs de texto (no escaneos) o un Excel válido.`);
  } finally {
    ui.btnValidar.disabled = false;
  }
});

// Une varios mapas de liquidación {legajo: emp} en uno solo.
function mergeLiquiMaps(maps) {
  if (maps.length === 0) return {};
  if (maps.length === 1) return maps[0];
  const out = {};
  for (const m of maps) {
    for (const legajo of Object.keys(m)) {
      out[legajo] = out[legajo] ? mergeEmpleado(out[legajo], m[legajo]) : m[legajo];
    }
  }
  return out;
}

function mergeEmpleado(a, b) {
  const r = { ...a };
  for (const k of Object.keys(b)) {
    const va = a[k], vb = b[k];
    if (Array.isArray(vb)) r[k] = (Array.isArray(va) ? va : []).concat(vb);
    else if (typeof vb === 'number') r[k] = (typeof va === 'number' ? va : 0) + vb;
    else if (va == null || va === '') r[k] = vb;
  }
  return r;
}

// Enriquece cada empleado con datos del recibo para mostrar en la tabla.
function enrich(reporte, liqui, recibos) {
  for (const emp of reporte.empleados) {
    const r = recibos[emp.legajo];
    emp.nombre = emp.nombre_liqui || emp.nombre_recibo || '';
    if (r) {
      emp.bruto = r.bruto; emp.neto = r.neto;
      emp.contrib = r.total_contribuciones; emp.costo = r.costo_empleador;
      emp.n_conceptos = r.conceptos.length;
      emp.torta = (r.porcentajes_torta && r.porcentajes_torta.length)
        ? Math.round(r.porcentajes_torta.reduce((a, b) => a + b, 0) * 100) / 100 : null;
    } else {
      emp.bruto = emp.neto = emp.contrib = emp.costo = null;
      emp.n_conceptos = 0; emp.torta = null;
    }
  }
}

// ─────────────── Render del reporte interactivo ───────────────
// F  = filtro por nivel de resultado (all/OK/ERROR/ADVERTENCIA/SIN_PAR)
// FT = filtro por TIPO de hallazgo (chips de categoría); null = sin filtro
// FC = filtro por CÓDIGO de concepto (panel conceptos más conflictivos); null = sin filtro
let D = null, F = 'all', FT = null, FC = null, SC = 'legajo', SD = 1, SQ = '', RUN_AT = null;

function fARS(n) {
  if (n == null) return '—';
  const neg = n < 0;
  const a = Math.abs(n).toFixed(2).split('.');
  a[0] = a[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + '$ ' + a[0] + ',' + a[1];
}
const SC_MAP = { OK: 'ok', ERROR: 'error', ADVERTENCIA: 'warn', SIN_PAR: 'sinpar' };
const SL_MAP = { OK: '✓ OK', ERROR: '✕ Error', ADVERTENCIA: '⚠ Advertencia', SIN_PAR: '? Sin par' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Metadatos por tipo de hallazgo: etiqueta para chips, etiqueta corta para la fila,
// y severidad (color). El orden del array fija el orden de los chips.
const TIPO_ORDER = ['MONTO_DIFIERE', 'TOTAL_DIFIERE', 'CONCEPTO_FALTANTE', 'CONCEPTO_DUPLICADO', 'TORTA_NO_SUMA', 'LEGAJO_SIN_PAR'];
const TIPO_META = {
  MONTO_DIFIERE: { label: 'monto difiere', short: 'monto', sev: 'error' },
  TOTAL_DIFIERE: { label: 'total difiere', short: 'total', sev: 'error' },
  CONCEPTO_FALTANTE: { label: 'concepto faltante', short: 'falta concepto', sev: 'error' },
  CONCEPTO_DUPLICADO: { label: 'concepto duplicado', short: 'duplicado', sev: 'error' },
  TORTA_NO_SUMA: { label: 'torta no suma', short: 'torta', sev: 'warn' },
  LEGAJO_SIN_PAR: { label: 'sin par', short: 'sin par', sev: 'neutral' },
};

// Cuenta EMPLEADOS distintos afectados por cada tipo de hallazgo (no ocurrencias:
// un empleado con 2 montos cuenta 1 vez para MONTO_DIFIERE). Así el número del chip
// coincide con las filas que se ven al filtrar por ese tipo.
function aggregateByTipo() {
  const counts = {};
  for (const e of D.empleados) {
    const seen = new Set();
    for (const h of (e.hallazgos || [])) {
      if (seen.has(h.tipo)) continue;
      seen.add(h.tipo);
      counts[h.tipo] = (counts[h.tipo] || 0) + 1;
    }
  }
  return counts;
}

// Agrega por CÓDIGO de concepto (sólo hallazgos con código: MONTO_DIFIERE,
// CONCEPTO_FALTANTE, CONCEPTO_DUPLICADO). Devuelve [{codigo, descripcion, n}] ordenado
// por empleados afectados desc. Es la vista de "causa raíz": un código que falla en
// muchos empleados suele ser un único problema sistémico.
function aggregateByCodigo() {
  const m = {};
  for (const e of D.empleados) {
    const seen = new Set();
    for (const h of (e.hallazgos || [])) {
      if (!h.codigo || seen.has(h.codigo)) continue;
      seen.add(h.codigo);
      const k = String(h.codigo);
      if (!m[k]) m[k] = { codigo: k, descripcion: h.descripcion || '', n: 0 };
      m[k].n += 1;
      if (!m[k].descripcion && h.descripcion) m[k].descripcion = h.descripcion;
    }
  }
  return Object.values(m).sort((a, b) => b.n - a.n || a.codigo.localeCompare(b.codigo));
}

// Resumen de tipos de un empleado para la fila (ej. "monto ×2 · total ×1").
function tipoSummary(e) {
  const counts = {};
  for (const h of (e.hallazgos || [])) counts[h.tipo] = (counts[h.tipo] || 0) + 1;
  return TIPO_ORDER.filter((t) => counts[t]).map((t) => {
    const m = TIPO_META[t];
    return `<span class="nom-tag sev-${m.sev}">${m.short}${counts[t] > 1 ? ' ×' + counts[t] : ''}</span>`;
  }).join('');
}

function render(reporte) {
  D = reporte;
  RUN_AT = new Date();
  // Errores primero: si hay diferencias, abrir directamente ese filtro.
  F = reporte.resumen.errores > 0 ? 'ERROR' : 'all';
  FT = null; FC = null;
  SC = 'legajo'; SD = 1; SQ = '';
  $('q').value = '';
  renderVerdict(); renderContext(); renderCards(); renderCatChips(); renderConceptos(); renderChip(); renderTable();
}

function renderVerdict() {
  const r = D.resumen;
  const el = ui.verdict;
  let cls, ico, title, sub;
  if (r.errores > 0) {
    cls = 'v-error'; ico = '!';
    title = `<b>${r.errores}</b> ${r.errores === 1 ? 'recibo requiere' : 'recibos requieren'} revisión`;
    const extra = [];
    if (r.advertencias > 0) extra.push(`${r.advertencias} ${r.advertencias === 1 ? 'advertencia' : 'advertencias'}`);
    if (r.sin_par > 0) extra.push(`${r.sin_par} sin par`);
    sub = `Mostrando primero las diferencias · ${r.ok} sin diferencias${extra.length ? ' · ' + extra.join(' · ') : ''}`;
  } else if (r.advertencias > 0) {
    cls = 'v-warn'; ico = '⚠';
    title = `<b>${r.advertencias}</b> ${r.advertencias === 1 ? 'advertencia' : 'advertencias'} para revisar`;
    sub = `Sin diferencias de monto · ${r.ok} recibos correctos${r.sin_par ? ' · ' + r.sin_par + ' sin par' : ''}`;
  } else if (r.sin_par > 0) {
    cls = 'v-warn'; ico = '?';
    title = `<b>${r.sin_par}</b> ${r.sin_par === 1 ? 'legajo sin par' : 'legajos sin par'}`;
    sub = `Sin diferencias de monto · ${r.ok} recibos correctos`;
  } else {
    cls = 'v-ok'; ico = '✓';
    title = `Todo cuadra`;
    sub = `Los ${r.total} recibos coinciden con la liquidación dentro de la tolerancia`;
  }
  el.className = 'verdict ' + cls;
  el.innerHTML = `<span class="v-ico">${ico}</span>
    <div class="v-txt"><div class="v-title">${title}</div><div class="v-sub">${sub}</div></div>`;
}

function renderContext() {
  const fmt = (d) => {
    const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
  };
  const cli = clientName();
  const items = [
    ['Empleados', String(D.resumen.total), ''],
    ['Archivos', `${state.liqui.length} liq · ${state.recibos.length} rec`, ''],
    ['Motor', 'Meta 4', ''],
    ['Corrida', fmt(RUN_AT || new Date()), ''],
    ['Tolerancia', '±$1,00 / total', ''],
  ];
  if (cli) items.unshift(['Cliente', cli, 'celeste']);
  ui.runctx.innerHTML = items.map(([l, v, c]) =>
    `<div class="rc"><span class="rc-l">${l}</span><span class="rc-v ${c}">${esc(v)}</span></div>`).join('');
}

function renderCards() {
  const r = D.resumen;
  // [label, valor, claseNum, detalle, filtro, claseKpi]
  const cards = [
    ['Total empleados', r.total, 'total', 'En este lote', 'all', ''],
    ['Sin diferencias', r.ok, 'ok', 'Recibos correctos', 'OK', 'k-ok'],
    ['Con errores', r.errores, 'error', 'Requieren revisión', 'ERROR', 'k-error'],
    ['Advertencias', r.advertencias, 'warn', 'Torta u otros', 'ADVERTENCIA', 'k-warn'],
  ];
  $('cards').innerHTML = cards.map(([l, v, c, d, f, kc]) =>
    `<div class="kpi ${kc}${F === f ? ' active' : ''}" data-f="${f}" role="button" tabindex="0" title="Filtrar: ${l}">
      <div class="kpi-l">${l}</div><div class="kpi-n c-${c}">${v}</div><div class="kpi-d">${d}</div></div>`).join('');
  document.querySelectorAll('.kpi').forEach((k) => {
    const go = () => { F = k.dataset.f; FT = null; FC = null; renderCards(); renderChip(); renderCatChips(); renderConceptos(); renderTable(); };
    k.addEventListener('click', go);
    k.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

function renderChip() {
  const r = D.resumen;
  const c = ui.chipSinpar;
  if (r.sin_par > 0) {
    c.className = 'chip-sinpar show' + (F === 'SIN_PAR' ? ' active' : '');
    c.textContent = `? ${r.sin_par} sin par`;
  } else {
    c.className = 'chip-sinpar';
    c.textContent = '';
  }
}
ui.chipSinpar.addEventListener('click', () => {
  F = (F === 'SIN_PAR') ? 'all' : 'SIN_PAR';
  FT = null; FC = null;
  renderCards(); renderChip(); renderCatChips(); renderConceptos(); renderTable();
});

// ─────────────── Chips de categoría (filtro por tipo de hallazgo) ───────────────
function renderCatChips() {
  const el = $('catchips');
  if (!D) { el.className = 'catchips'; el.innerHTML = ''; return; }
  const counts = aggregateByTipo();
  const present = TIPO_ORDER.filter((t) => counts[t] > 0);
  if (!present.length) { el.className = 'catchips'; el.innerHTML = ''; return; }
  el.className = 'catchips show';
  const lead = `<span class="cc-lead">Categorías</span>`;
  el.innerHTML = lead + present.map((t) => {
    const m = TIPO_META[t]; const n = counts[t];
    return `<button class="catchip sev-${m.sev}${FT === t ? ' active' : ''}" data-t="${t}" aria-pressed="${FT === t}"
      title="Filtrar por: ${m.label} — ${n} ${n === 1 ? 'empleado' : 'empleados'}">
      <span class="cc-dot"></span>${m.label}<span class="cc-n">${n}</span></button>`;
  }).join('');
  el.querySelectorAll('.catchip').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.t;
    FT = (FT === t) ? null : t;   // toggle
    FC = null; F = 'all';         // el tipo manda: limpiar código y ver todos los niveles
    renderCards(); renderChip(); renderCatChips(); renderConceptos(); renderTable();
  }));
}

// ─────────────── Conceptos más conflictivos (causa raíz) ───────────────
function renderConceptos() {
  const el = $('conceptos');
  if (!D) { el.className = 'conceptos'; el.innerHTML = ''; return; }
  const items = aggregateByCodigo();
  const top = items.slice(0, 8);
  // Sólo vale la pena el panel si hay al menos un código que afecte a 2+ empleados.
  if (!top.length || top[0].n < 2) { el.className = 'conceptos'; el.innerHTML = ''; return; }
  el.className = 'conceptos show';
  const max = top[0].n || 1;
  const head = `<div class="cn-head">
    <span class="cn-ico" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <span class="cn-title">Conceptos más conflictivos</span>
    <span class="cn-sub">una causa, varios empleados · clic para filtrar</span></div>`;
  const rows = top.map((x) => {
    const w = Math.max(6, Math.round((x.n / max) * 100));
    return `<div class="cn-row${FC === x.codigo ? ' active' : ''}" data-c="${esc(x.codigo)}" role="button" tabindex="0"
      title="Filtrar por código ${esc(x.codigo)} — ${x.n} ${x.n === 1 ? 'empleado' : 'empleados'}">
      <span class="cn-code">${esc(x.codigo)}</span>
      <span class="cn-name" title="${esc(x.descripcion || '')}">${esc(x.descripcion || '—')}</span>
      <span class="cn-bar"><span style="width:${w}%"></span></span>
      <span class="cn-n">${x.n} <span>empl.</span></span></div>`;
  }).join('');
  el.innerHTML = head + rows;
  el.querySelectorAll('.cn-row').forEach((r) => {
    const go = () => {
      const c = r.dataset.c;
      FC = (FC === c) ? null : c;   // toggle
      FT = null; F = 'all';
      renderCards(); renderChip(); renderCatChips(); renderConceptos(); renderTable();
    };
    r.addEventListener('click', go);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

function visible() {
  const q = SQ.toLowerCase();
  const numeric = ['legajo', 'bruto', 'neto', 'contrib', 'costo', 'torta', 'n_conceptos'];
  return D.empleados.filter((e) => {
    if (F !== 'all' && e.resultado !== F) return false;
    if (FT && !(e.hallazgos || []).some((h) => h.tipo === FT)) return false;
    if (FC && !(e.hallazgos || []).some((h) => String(h.codigo) === String(FC))) return false;
    if (q && !e.nombre.toLowerCase().includes(q) && !e.legajo.includes(q)) return false;
    return true;
  }).sort((a, b) => {
    let av = a[SC], bv = b[SC];
    if (numeric.includes(SC)) {
      av = av == null ? -Infinity : (SC === 'legajo' ? parseInt(av, 10) : av);
      bv = bv == null ? -Infinity : (SC === 'legajo' ? parseInt(bv, 10) : bv);
    } else {
      av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
    }
    return av < bv ? -SD : av > bv ? SD : 0;
  });
}

function renderTable() {
  const rows = visible();
  const tb = $('tbody'), empty = $('empty');
  document.querySelectorAll('th[data-col]').forEach((t) => {
    t.classList.toggle('sorted', t.dataset.col === SC);
    const i = t.querySelector('.si');
    if (i) i.textContent = t.dataset.col === SC ? (SD === 1 ? '↑' : '↓') : '↕';
  });
  if (!rows.length) {
    tb.innerHTML = ''; empty.style.display = ''; $('footcount').textContent = 'Sin resultados.';
    return;
  }
  empty.style.display = 'none';
  $('footcount').innerHTML = `Mostrando <b>${rows.length}</b> de ${D.empleados.length} empleados`;

  tb.innerHTML = rows.flatMap((e) => {
    const s = SC_MAP[e.resultado] || 'sinpar';
    const hi = e.hallazgos && e.hallazgos.length > 0;
    const t = e.torta != null ? e.torta.toFixed(2) + '%' : '—';
    const tc = e.torta != null && Math.abs(e.torta - 100) <= 1 ? 'ok' : 'warn';
    const tags = tipoSummary(e);
    const main = `<tr class="row s-${s}${hi ? ' hi' : ''}" data-leg="${esc(e.legajo)}">
      <td class="leg">${esc(e.legajo)}</td>
      <td><div class="nom-wrap"><span class="nom">${esc(e.nombre)}</span>${tags ? `<div class="nom-tags">${tags}</div>` : ''}</div></td>
      <td class="r">${fARS(e.bruto)}</td>
      <td class="r">${fARS(e.neto)}</td>
      <td class="r">${fARS(e.contrib)}</td>
      <td class="r">${fARS(e.costo)}</td>
      <td class="c"><span class="torta ${tc}">${t}</span></td>
      <td class="c" style="color:var(--t3)">${e.n_conceptos}</td>
      <td class="c"><span class="pill p-${s}">${SL_MAP[e.resultado] || e.resultado}</span></td>
      <td class="c">${hi ? '<span class="xi">▶</span>' : ''}</td></tr>`;
    const detail = hi ? `<tr class="dr" data-leg="${esc(e.legajo)}"><td colspan="10"><div class="di">
      <table class="dt"><thead><tr><th>Tipo</th><th>Código</th><th>Descripción / Detalle</th>
      <th class="r">Liquidación</th><th class="r">Recibo</th><th class="r">Diferencia</th></tr></thead><tbody>
      ${e.hallazgos.map((h) => `<tr>
        <td><span class="ht t-${h.tipo}">${h.tipo.replace(/_/g, ' ')}</span></td>
        <td class="num" style="color:var(--t3)">${esc(h.codigo) || '—'}</td>
        <td>${esc(h.descripcion || h.mensaje)}</td>
        <td class="r">${h.monto_liqui != null ? fARS(h.monto_liqui) : '—'}</td>
        <td class="r">${h.monto_recibo != null ? fARS(h.monto_recibo) : '—'}</td>
        <td class="r dif-neg">${h.diferencia != null ? fARS(h.diferencia) : '—'}</td></tr>`).join('')}
      </tbody></table></div></td></tr>` : '';
    return [main, detail];
  }).join('');

  tb.querySelectorAll('tr.hi').forEach((tr) => tr.addEventListener('click', () => {
    const l = tr.dataset.leg;
    const d = tb.querySelector(`tr.dr[data-leg="${CSS.escape(l)}"]`);
    if (!d) return;
    const open = tr.classList.toggle('open');
    d.classList.toggle('open', open);
  }));
}

document.querySelectorAll('th[data-col]').forEach((t) => t.addEventListener('click', () => {
  const c = t.dataset.col;
  if (SC === c) SD *= -1; else { SC = c; SD = 1; }
  renderTable();
}));
$('q').addEventListener('input', (e) => { SQ = e.target.value; renderTable(); });

// ─────────────── Barra compacta tras validar ───────────────
function fillRunbar(reporte) {
  const liq = state.liqui.map((f) => f.name).join(', ');
  const rec = state.recibos.map((f) => f.name).join(', ');
  const txt = `${liq}  ·  ${rec}`;
  const cli = clientName();
  ui.rbCliente.textContent = cli || 'Sin nombre';
  ui.rbCliente.title = cli || 'Sin nombre de cliente';
  ui.rbFiles.textContent = txt;
  ui.rbFiles.title = txt;
  ui.rbCount.innerHTML = `<b>${reporte.resumen.total}</b> empleados`;
}

// ─────────────── Exportar diferencias a CSV ───────────────
ui.btnExport.addEventListener('click', () => {
  if (!D) return;
  const conDif = D.empleados.filter((e) => e.hallazgos && e.hallazgos.length > 0);
  if (!conDif.length) { alert('No hay diferencias para exportar: todos los recibos coinciden con la liquidación.'); return; }
  const num = (n) => (n == null ? '' : Number(n).toFixed(2).replace('.', ','));
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const cli = clientName();
  const header = ['Cliente', 'Legajo', 'Nombre', 'Estado', 'Tipo', 'Código', 'Descripción', 'Liquidación', 'Recibo', 'Diferencia'];
  const lines = [header.map(q).join(';')];
  for (const e of conDif) {
    for (const h of e.hallazgos) {
      lines.push([
        q(cli), q(e.legajo), q(e.nombre), q(e.resultado),
        q(h.tipo.replace(/_/g, ' ')), q(h.codigo || ''), q(h.descripcion || h.mensaje || ''),
        q(num(h.monto_liqui)), q(num(h.monto_recibo)), q(num(h.diferencia)),
      ].join(';'));
    }
  }
  const csv = '\uFEFF' + lines.join('\r\n'); // BOM para acentos en Excel
  const stamp = (RUN_AT || new Date()).toISOString().slice(0, 10);
  const slug = cli ? cli.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() : '';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `diferencias_${slug ? slug + '_' : ''}${stamp}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
});
