// pdf-extract.js
// Extracción de texto desde PDF usando pdf.js, reconstruyendo líneas a partir de
// las posiciones (x,y) de cada fragmento. Insertar espacios según el gap horizontal
// separa columnas que de otro modo quedarían pegadas (bug de dígitos concatenados
// que tenía el parser Python basado en pdfplumber).
//
// Módulo agnóstico del entorno: el caller inyecta la instancia de pdf.js.
//   - Browser:  window.pdfjsLib  (cargado por <script> del build vendoreado)
//   - Node:     import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js'

const Y_TOL = 3.0;          // pts: fragmentos con |Δy| menor a esto = misma línea
const SPACE_FACTOR = 0.25;  // gap > SPACE_FACTOR * fontSize => insertar un espacio

// Reconstruye el texto de una página (array de líneas unidas por \n) a partir de
// los items de page.getTextContent().
export function reconstructPageText(items) {
  const frags = [];
  for (const it of items) {
    if (it.str === undefined || it.str === null) continue;
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    const h = it.height || Math.hypot(t[1], t[3]) || 10;
    frags.push({
      str: it.str,
      x: t[4],
      y: t[5],
      w: it.width || 0,
      h,
    });
  }
  if (!frags.length) return '';

  // Ordenar de arriba hacia abajo (y descendente: origen abajo-izquierda en PDF),
  // y a igual línea, de izquierda a derecha.
  frags.sort((a, b) => (Math.abs(a.y - b.y) <= Y_TOL ? a.x - b.x : b.y - a.y));

  const lines = [];
  let line = [frags[0]];
  let refY = frags[0].y;
  for (let i = 1; i < frags.length; i++) {
    const f = frags[i];
    if (Math.abs(f.y - refY) <= Y_TOL) {
      line.push(f);
    } else {
      lines.push(line);
      line = [f];
      refY = f.y;
    }
  }
  lines.push(line);

  const out = [];
  for (const ln of lines) {
    ln.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    let prevH = ln[0].h;
    for (const f of ln) {
      if (prevEnd !== null) {
        const gap = f.x - prevEnd;
        const threshold = SPACE_FACTOR * Math.max(prevH, f.h);
        const endsWithSpace = /\s$/.test(text);
        const startsWithSpace = /^\s/.test(f.str);
        if (gap > threshold && !endsWithSpace && !startsWithSpace) {
          text += ' ';
        }
      }
      text += f.str;
      prevEnd = f.x + f.w;
      prevH = f.h;
    }
    out.push(text.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

// Extrae el texto de todas las páginas de un PDF.
// `data` es un ArrayBuffer / Uint8Array con los bytes del PDF.
// `onProgress(paginaActual, totalPaginas)` es opcional (para mostrar progreso).
// Devuelve un array de strings (una por página).
export async function extractPagesText(data, pdfjsLib, onProgress) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(reconstructPageText(tc.items));
    page.cleanup();
    if (onProgress) onProgress(i, doc.numPages);
  }
  await doc.destroy();
  return pages;
}
