#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// PostToolUse reminder — Validador de Recibos (H&A)
// El proyecto exige correr ciertas verificaciones PROACTIVAMENTE (ver CLAUDE.md),
// pero eso depende de que el modelo se acuerde. Este hook lo hace DETERMINÍSTICO:
// tras editar el MOTOR o la UI, recuerda qué verificación corresponde antes de
// mergear. No bloquea nada (la tool ya corrió); sólo le pasa el recordatorio a
// Claude por stderr (exit 2 = feedback a Claude en PostToolUse).
//
// Anti-ruido: recuerda UNA sola vez por sesión y por categoría (motor / UI),
// usando un marcador en el temp del SO keyed por un hash del session_id. Ediciones
// siguientes de la misma categoría en la misma sesión no repiten el aviso.
// ─────────────────────────────────────────────────────────────────────────────

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let ev;
  try {
    ev = JSON.parse(raw || '{}');
  } catch {
    process.exit(0); // si no entendemos el evento, no molestamos
  }

  try {
    const tool = ev.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') process.exit(0);

    const fp = String((ev.tool_input || {}).file_path || '').replace(/\\/g, '/');
    if (!fp) process.exit(0);

    // Categoría del archivo tocado.
    const esMotor = /docs\/parsers\//i.test(fp) || /docs\/core\/validador\.js$/i.test(fp);
    const esUI = /docs\/(index\.html|app\.js|styles\.css)$/i.test(fp);
    const cat = esMotor ? 'motor' : esUI ? 'ui' : null;
    if (!cat) process.exit(0);

    // Una vez por sesión + categoría. Hash del session_id → nombre de archivo seguro y sin colisiones.
    const sid = createHash('sha256').update(String(ev.session_id || 'nosession')).digest('hex').slice(0, 16);
    const flag = join(tmpdir(), `vr-reminder-${cat}-${sid}.flag`);
    if (existsSync(flag)) process.exit(0);
    try { writeFileSync(flag, '1'); } catch { /* si no podemos marcar, igual avisamos una vez */ }

    const msg =
      cat === 'motor'
        ? 'RECORDATORIO (tocaste el MOTOR: parsers/validador). Antes de mergear:\n' +
          '  1) Corré /verify-golden — el resultado esperado es 531 / 518 OK / 13 error / 0 sin par.\n' +
          '  2) Lanzá el subagent business-rules-reviewer sobre el diff (match por código, valor absoluto,\n' +
          '     rango contribuciones 6050–7099, tolerancias, consolidación multi-bloque).'
        : 'RECORDATORIO (tocaste la UI: index.html / styles.css / app.js). Antes de mergear:\n' +
          '  1) Corré /smoke-ui — bootea sin errores de consola y togglea dark/claro.\n' +
          '  2) Considerá el subagent ui-brand-reviewer (marca H&A + accesibilidad + contraste en ambos temas).\n' +
          '  NOTA: la UI no cambia el motor, así que /verify-golden no es obligatorio por este cambio.';

    console.error(msg);
    process.exit(2); // PostToolUse: stderr → feedback a Claude (no bloquea, la tool ya corrió)
  } catch {
    process.exit(0); // ante cualquier error, no interrumpir el flujo
  }
});
