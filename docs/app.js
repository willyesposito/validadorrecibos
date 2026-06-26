// app.js — Orquestación en el navegador: carga de archivos → extracción → parseo
// → validación → reporte interactivo. Todo client-side; nada se sube a internet.

import { extractPagesText } from './parsers/pdf-extract.js';
import { parseRecibos } from './parsers/parser-recibos.js';
import { parseLiquidacionPdf } from './parsers/parser-liquidacion-pdf.js';
import { parseLiquidacionXlsx } from './parsers/parser-liquidacion-xlsx.js';
import { validar } from './core/validador.js';

// pdf.js viene del <script> vendoreado (global pdfjsLib). Worker self-hosted.
const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

// ─────────────── Estado de archivos ───────────────
// liqui y recibos son ambos arrays: se admiten varios archivos por lado y se cruzan
// contra un conjunto unificado (consolidado por legajo). Útil cuando hay anexos /
// confidenciales que se agregan aparte y deben sumarse a la liquidación principal.
const state = { liqui: [], recibos: [] };

const $ = (id) => document.getElementById(id);
const ui = {
  inLiqui: $('in-liqui'), inRecibos: $('in-recibos'),
  dzLiqui: $('dz-liqui'), dzRecibos: $('dz-recibos'),
  filesLiqui: $('files-liqui'), filesRecibos: $('files-recibos'),
  btnValidar: $('btn-validar'), btnReset: $('btn-reset'),
  progress: $('progress'), ptxt: $('ptxt'),
  errbanner: $('errbanner'), errtext: $('errtext'),
  results: $('results'),
};

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

ui.btnReset.addEventListener('click', () => {
  state.liqui = []; state.recibos = [];
  ui.inLiqui.value = ''; ui.inRecibos.value = '';
  setLiqui([]); setRecibos([]);
  ui.results.classList.remove('show');
  ui.errbanner.classList.remove('show');
  ui.btnReset.style.display = 'none';
});

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
        liquiMaps.push(parseLiquidacionXlsx(rows));
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
    ui.btnReset.style.display = '';
    ui.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
// Caso normal (un solo archivo, o varios PDF que el parser ya consolidó): hay un único
// mapa y no se fusiona nada. Si un mismo legajo aparece en más de un archivo, se consolida
// igual que multi-bloque: los conceptos se concatenan y los campos numéricos se suman.
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
    if (Array.isArray(vb)) r[k] = (Array.isArray(va) ? va : []).concat(vb); // conceptos, errores_parse…
    else if (typeof vb === 'number') r[k] = (typeof va === 'number' ? va : 0) + vb; // bruto, neto, totales…
    else if (va == null || va === '') r[k] = vb; // legajo/nombre: se conserva el primero no vacío
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
let D = null, F = 'all', SC = 'legajo', SD = 1, SQ = '';

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

function render(reporte) {
  D = reporte; F = 'all'; SC = 'legajo'; SD = 1; SQ = '';
  $('q').value = '';
  renderCards(); renderFilters(); renderTable();
}

function renderCards() {
  const r = D.resumen;
  const cards = [
    ['Total empleados', r.total, 'total', 'En este lote'],
    ['Sin diferencias', r.ok, 'ok', 'Recibos correctos'],
    ['Con errores', r.errores, 'error', 'Requieren revisión'],
    ['Advertencias', r.advertencias, 'warn', 'Torta u otros'],
  ];
  $('cards').innerHTML = cards.map(([l, v, c, d]) =>
    `<div class="kpi"><div class="kpi-l">${l}</div><div class="kpi-n c-${c}">${v}</div><div class="kpi-d">${d}</div></div>`).join('');
}

function renderFilters() {
  const r = D.resumen;
  const fs = [
    ['all', `Todos (${r.total})`], ['OK', `OK (${r.ok})`], ['ERROR', `Errores (${r.errores})`],
    ['ADVERTENCIA', `Advertencias (${r.advertencias})`], ['SIN_PAR', `Sin par (${r.sin_par})`],
  ];
  $('filters').innerHTML = fs.map(([id, lbl]) =>
    `<button class="fbtn${F === id ? ' active' : ''}" data-f="${id}">${lbl}</button>`).join('');
  document.querySelectorAll('.fbtn').forEach((b) => b.addEventListener('click', () => {
    F = b.dataset.f; renderTable(); renderFilters();
  }));
}

function visible() {
  const q = SQ.toLowerCase();
  const numeric = ['legajo', 'bruto', 'neto', 'contrib', 'costo', 'torta', 'n_conceptos'];
  return D.empleados.filter((e) => {
    if (F !== 'all' && e.resultado !== F) return false;
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
  $('footcount').textContent = `Mostrando ${rows.length} de ${D.empleados.length} empleados`;

  tb.innerHTML = rows.flatMap((e) => {
    const s = SC_MAP[e.resultado] || 'sinpar';
    const hi = e.hallazgos && e.hallazgos.length > 0;
    const t = e.torta != null ? e.torta.toFixed(2) + '%' : '—';
    const tc = e.torta != null && Math.abs(e.torta - 100) <= 1 ? 'ok' : 'warn';
    const main = `<tr class="row s-${s}${hi ? ' hi' : ''}" data-leg="${esc(e.legajo)}">
      <td class="leg">${esc(e.legajo)}</td>
      <td class="nom">${esc(e.nombre)}</td>
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
