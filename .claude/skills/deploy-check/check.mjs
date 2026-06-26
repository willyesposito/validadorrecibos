#!/usr/bin/env node
// Checklist pre-merge / pre-Pages del Validador de Recibos.
// Corre desde la raíz del repo:  node .claude/skills/deploy-check/check.mjs
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

let fails = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  console.log(`  ⛔ ${m}`);
  fails++;
};

console.log('— deploy-check: apto para mergear a main + publicar en Pages —\n');

// 1) Ningún dato real versionado
console.log('1) Datos reales NO versionados');
let tracked = [];
try {
  tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  bad('no pude correr `git ls-files` (¿estás en la raíz del repo?)');
}
const peligro = tracked.filter((f) =>
  /\.(pdf|xlsx|xls|csv)$/i.test(f) ||
  /(^|\/)Archivos\//i.test(f) ||
  /reporte\.html$/i.test(f)
);
if (peligro.length) {
  bad(`HAY datos reales trackeados (${peligro.length}): ${peligro.slice(0, 10).join(', ')}`);
} else {
  ok('git no trackea PDFs/Excel/CSV/Archivos/reporte.html');
}

// 2) .nojekyll
console.log('2) docs/.nojekyll');
existsSync('docs/.nojekyll') ? ok('presente') : bad('FALTA docs/.nojekyll (Jekyll puede romper /vendor)');

// 3) index.html
console.log('3) docs/index.html');
existsSync('docs/index.html') ? ok('presente') : bad('FALTA docs/index.html (raíz de Pages)');

// 4) vendor libs
console.log('4) Librerías vendoreadas (docs/vendor)');
for (const lib of ['pdf.min.js', 'pdf.worker.min.js', 'xlsx.full.min.js']) {
  existsSync(`docs/vendor/${lib}`) ? ok(lib) : bad(`FALTA docs/vendor/${lib}`);
}

console.log(`\n${fails === 0 ? '✅ TODO OK — apto para mergear/publicar.' : `⛔ ${fails} control(es) fallaron — NO mergear hasta resolver.`}`);
process.exit(fails === 0 ? 0 : 1);
