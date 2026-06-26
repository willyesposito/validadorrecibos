#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// PreToolUse guard — Validador de Recibos (H&A)
// Lee el evento de hook por stdin y BLOQUEA (exit 2) acciones peligrosas:
//   1) versionar datos reales de payroll (repo público + GitHub Pages = riesgo PII)
//   2) editar a mano las librerías vendoreadas de docs/vendor/
// exit 2 = bloquea la tool y le devuelve a Claude el mensaje de stderr.
// ─────────────────────────────────────────────────────────────────────────────

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let ev;
  try {
    ev = JSON.parse(raw || '{}');
  } catch {
    process.exit(0); // si no entendemos el evento, no bloqueamos
  }

  const tool = ev.tool_name || '';
  const inp = ev.tool_input || {};

  // 1) Datos reales de payroll: nunca versionar.
  if (tool === 'Bash') {
    const cmd = String(inp.command || '');
    const esGit = /\bgit\s+(add|commit|stash)\b/.test(cmd);
    const tocaDatos =
      /(\.pdf|\.xlsx|\.xls|\.csv|Archivos\/|reporte\.html|data\/[^\s'"]*\.(pdf|xlsx|xls|csv|json|html))/i.test(
        cmd
      );
    if (esGit && tocaDatos) {
      console.error(
        'BLOQUEADO (privacidad payroll): el comando intenta versionar datos reales ' +
          '(PDF/Excel/CSV/Archivos/). Este repo es PÚBLICO y se publica en GitHub Pages — ' +
          'ningún recibo, liquidación ni dato de empleados puede entrar al repo. ' +
          'Si fuera un falso positivo, corré el git a mano fuera de Claude.'
      );
      process.exit(2);
    }
  }

  // 2) Librerías vendoreadas: no se editan a mano.
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    const fp = String(inp.file_path || '').replace(/\\/g, '/');
    if (/docs\/vendor\//i.test(fp)) {
      console.error(
        'BLOQUEADO: docs/vendor/ son librerías vendoreadas (pdf.js, SheetJS) self-hosted. ' +
          'No se editan a mano. Para actualizar, reemplazá el archivo completo por la build ' +
          'nueva de la librería.'
      );
      process.exit(2);
    }
  }

  process.exit(0);
});
