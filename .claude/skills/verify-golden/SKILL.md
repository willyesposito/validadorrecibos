---
name: verify-golden
description: Corre el Validador de Recibos sobre los PDFs locales (gitignoreados) y compara el resultado contra la referencia dorada documentada (531 / 518 OK / 13 error / 0 sin par). Claude debe ejecutarla PROACTIVAMENTE (sin que se la pidan) cada vez que se toque un parser (docs/parsers/*) o el validador (docs/core/validador.js), y antes de mergear a main.
---

# /verify-golden — Verificación contra la referencia dorada

Confirma que el motor JS sigue reproduciendo la **referencia dorada** del motor Python
sobre los mismos PDF reales. Es la barra de calidad del proyecto: el motor no tiene tests
unitarios, su corrección se mide así.

> **Privacidad:** esta verificación usa los PDF/Excel reales de `data/` o `Archivos/`, que
> están **gitignoreados** y nunca se versionan. Sólo corre en la máquina de quien tiene los
> datos. Nunca subas esos archivos ni el reporte resultante.

## Resultado esperado (golden)
Para los PDF de prueba de junio 2026 (Marval): **531 empleados · 518 OK · 13 error · 0 sin par.**
(Ver `CLAUDE.md` → "Verificación (referencia dorada)" para el detalle y los casos conocidos:
legajos 6851 y 7269.)

## Procedimiento (ruta navegador — la confiable)
1. Arrancá el server estático: `python -m http.server 8123` desde la raíz del repo
   (o usá el preview de Claude Code, config en `.claude/launch.json`).
2. Abrí `http://localhost:8123/docs/index.html` (con `preview_start` si usás el preview).
3. Cargá la liquidación y los recibos reales desde `data/` programáticamente (preview_eval:
   construir `File` desde los bytes y disparar el handler de `app.js`), o a mano por la UI.
4. Esperá a que termine y leé los KPIs (total / OK / error / sin par) del DOM.
5. **Compará contra el golden de arriba.** Reportá:
   - ✅ si total/OK/error coinciden exactamente.
   - ⛔ si cualquier conteo difiere → listá los legajos que cambiaron de estado respecto del
     golden (son el punto de partida para diagnosticar la regresión).
6. Para los 13 errores conocidos, verificá que sigan siendo los mismos legajos (no nuevos).

## Qué hacer si NO coincide
- Un conteo distinto significa que un cambio en parsers/validador alteró la lógica.
- Identificá los legajos que cambiaron de estado, leé su bloque parseado y compará la rama
  de código que tocaste contra las reglas de negocio (ver el subagent `business-rules-reviewer`).
- No mergees hasta volver a 531/518/13 **o** entender y documentar por qué el número correcto
  cambió (como pasó con el falso `TORTA_NO_SUMA` del legajo 6851).

## Nota
Si en el futuro se arma un golden distinto (otro período / otro cliente), actualizá los
números esperados de este skill y la sección de verificación de `CLAUDE.md` en el mismo commit.
