---
name: deploy-check
description: Checklist pre-merge a main / pre-publicación en GitHub Pages. Verifica que NO haya datos reales versionados, que la estructura /docs esté intacta y que Pages quede servible. Claude debe ejecutarla PROACTIVAMENTE (sin que se la pidan) antes de cualquier commit que vaya a main o de proponer mergear el PR.
---

# /deploy-check — Checklist antes de publicar en GitHub Pages

Valida que el repo esté apto para mergear a `main` y publicarse en GitHub Pages **sin filtrar
datos** y **sin romper el sitio**.

## Cómo correrlo
Ejecutá el script de chequeo desde la raíz del repo:

```bash
node .claude/skills/deploy-check/check.mjs
```

Devuelve PASS/FAIL por cada control y sale con código ≠ 0 si algo falla.

## Qué controla
1. **Ningún dato real versionado** — `git ls-files` no debe listar `*.pdf`, `*.xlsx`, `*.xls`,
   `*.csv`, nada bajo `Archivos/`, ni `reporte.html`. (Es la regla de privacidad #1: el repo es
   público y va a Pages.)
2. **`docs/.nojekyll` presente** — sin él, GitHub procesa el sitio con Jekyll y puede romper
   rutas que empiezan con `_` o carpetas como `vendor`.
3. **`docs/index.html` presente** — es la raíz que sirve Pages.
4. **Librerías vendoreadas presentes** — `docs/vendor/pdf.min.js`, `pdf.worker.min.js`,
   `xlsx.full.min.js` (sin CDN en runtime, deben estar self-hosted).

## Recordatorio de configuración de Pages
Tras mergear a `main`, GitHub Pages debe quedar en **Source = Deploy from a branch ·
Branch `main` · carpeta `/docs`** (NO `/(root)`: el `index.html` vive en `/docs`).
URL pública: `https://willyesposito.github.io/validadorrecibos/`.
