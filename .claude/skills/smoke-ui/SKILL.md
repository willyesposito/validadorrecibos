---
name: smoke-ui
description: Smoke test rápido de la UI del Validador SIN datos reales — arranca el preview, carga la página y verifica que bootea sin errores de consola y que la estructura clave existe (inputs de archivos, botón validar, header/footer). Si la build tiene dark mode, verifica además que el toggle claro/oscuro funciona y persiste. Complementa verify-golden (que SÍ necesita datos reales). Claude debe correrla PROACTIVAMENTE tras tocar la capa de UI (docs/index.html, docs/styles.css, docs/app.js) y antes de mergear.
---

# /smoke-ui — Smoke test de la UI (sin datos reales)

Verifica que la página **arranca sana** tras un cambio de UI. Es complementaria, no
sustituta, de `/verify-golden`:

| Skill | Qué prueba | Necesita datos reales |
|-------|-----------|------------------------|
| `smoke-ui`     | que la UI bootea, no tira errores JS y (si existe) el tema togglea | **No** |
| `verify-golden`| que el MOTOR reproduce el golden 531/518/13                        | **Sí** (PDFs gitignoreados) |

Por eso `smoke-ui` se puede correr siempre (no toca PII), y es la verificación adecuada para
cambios **solo de UI** (estilos, dark mode, layout) donde correr el golden no aporta.

## Prerequisito
Requiere el **MCP de preview** de Claude Code (`Claude_Preview`: `preview_start`, `preview_eval`,
`preview_console_logs`, `preview_screenshot`, `preview_stop`). Si no está disponible, arrancá el
server con `python -m http.server 8123` desde la raíz del repo y verificá los mismos checks
abriendo `http://localhost:8123/docs/index.html` a mano (consola del navegador + inspección del DOM).

## Procedimiento (preview de Claude Code)
1. Arrancá el server: `preview_start` con la config `validador` de `.claude/launch.json`
   (sirve la raíz del repo en `http://localhost:8123`).
2. Cargá `http://localhost:8123/docs/index.html` (con `preview_eval` seteando `location.href`,
   o navegando directo si el preview lo permite).
3. **Errores de consola:** `preview_console_logs` con `level: "error"` → debe venir **vacío**.
   (Warnings benignos se toleran; errores JS, no.)
4. **Estructura clave** (con `preview_eval`, leyendo el DOM). Deben existir:
   - los dos file inputs: `#in-liqui` y `#in-recibos`
   - el botón de validar: `#btn-validar` (arranca `disabled`)
   - la marca del header (`.hdr` con el logo o el isotipo) y el footer (`.foot`)
5. **Dark mode (si la build lo tiene):** si existe `#btn-theme`:
   - leé `document.documentElement.dataset.theme` y `getComputedStyle(document.body).backgroundColor`,
   - hacé click en `#btn-theme`, confirmá que `data-theme` cambió (dark↔light), que
     `localStorage.theme` quedó persistido y que el fondo del body cambió (esperá a que termine
     la transición de ~0,22 s antes de releer el color),
   - volvé a togglear para dejarlo como estaba.
   Si NO existe `#btn-theme`, anotá "esta build no tiene toggle de tema" y seguí (no es fallo).
6. **Favicon (defensivo):** `const fi = document.querySelector('link[rel=icon]')`. Si existe,
   confirmá que `fi.href` apunta al logo; si NO existe, anotá "esta build no define favicon" y
   seguí (no es fallo — nunca leas `.href` de un `null`).
7. **Evidencia:** sacá un `preview_screenshot` (en claro y, si aplica, en oscuro) para adjuntar.
8. Al terminar, frená el server con `preview_stop`.

## Veredicto
- ✅ **OK** — la página bootea sin errores de consola, la estructura clave está, y (si aplica)
  el tema togglea y persiste.
- ⛔ **FALLA** — listá el check exacto que falló (error de consola con su texto, elemento
  faltante, o toggle que no cambia/persiste). Es el punto de partida para diagnosticar.

## Nota
`smoke-ui` NO valida la corrección del motor ni los números del reporte: para eso, datos reales
+ `/verify-golden`. Si tocaste parsers o `core/validador.js`, corré ese además de este.
