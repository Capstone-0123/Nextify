'use strict';

// Next/Webpack/Turbopack 빌드 단계에서 터지는 "Module not found" 중
// tsc 가 declare module 와일드카드로 놓치는 케이스(폰트·이미지·css 등)를
// 결정론적으로 나열한다. 자동 생성/추측 스텁은 하지 않는다.

const fs = require('fs-extra');
const path = require('path');
const { Project, SyntaxKind } = require('ts-morph');
const { resolveImportSpecifierToAbsPath } = require('./typecheck-module-resolve.cjs');

const REPORT_FILE = 'nextify-static-import-report.txt';

function stripQuery(spec) {
  if (!spec || typeof spec !== 'string') return '';
  const q = spec.indexOf('?');
  return q === -1 ? spec : spec.slice(0, q);
}

function loadPathPatterns(projectRoot) {
  const p = path.join(projectRoot, 'tsconfig.json');
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readJsonSync(p);
    const paths = raw.compilerOptions?.paths;
    if (!paths || typeof paths !== 'object') return [];
    return Object.keys(paths);
  } catch {
    return [];
  }
}

function specMatchesPathAlias(spec, pattern) {
  const i = pattern.indexOf('*');
  if (i === -1) return spec === pattern;
  const pre = pattern.slice(0, i);
  const post = pattern.slice(i + 1);
  if (!spec.startsWith(pre)) return false;
  if (post && !spec.endsWith(post)) return false;
  return true;
}

function isPathAliasSpecifier(spec, patterns) {
  for (const pat of patterns) {
    if (specMatchesPathAlias(spec, pat)) return true;
  }
  return false;
}

function shouldTryResolve(spec, patterns) {
  const s = stripQuery(spec);
  if (!s || s.startsWith('node:')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false;
  if (s.startsWith('.') || s.startsWith('..')) return true;
  return isPathAliasSpecifier(s, patterns);
}

function toProjectRelative(projectRoot, absFile) {
  return path.relative(projectRoot, absFile).split(path.sep).join('/');
}

/**
 * @param {string} projectRoot
 * @returns {Promise<{ ran: boolean, reason?: string, scannedFiles: number, missing: Array<{ file: string, line: number, spec: string }> }>}
 */
async function runStaticImportScan(projectRoot) {
  const tsconfig = path.join(projectRoot, 'tsconfig.json');
  if (!(await fs.pathExists(tsconfig))) {
    return { ran: false, reason: 'no_tsconfig', scannedFiles: 0, missing: [] };
  }

  const patterns = loadPathPatterns(projectRoot);
  let project;
  try {
    project = new Project({ tsConfigFilePath: tsconfig });
  } catch {
    return { ran: false, reason: 'tsconfig_load_error', scannedFiles: 0, missing: [] };
  }

  const sourceFiles = project.getSourceFiles().filter((sf) => {
    const fp = sf.getFilePath();
    if (fp.includes(`${path.sep}node_modules${path.sep}`)) return false;
    return /\.(m|c)?[jt]sx?$/.test(fp);
  });

  /** @type {Map<string, { file: string, line: number, spec: string }>} */
  const missing = new Map();

  const recordMissing = (relImporter, line, rawSpec) => {
    const spec = stripQuery(rawSpec);
    if (!shouldTryResolve(rawSpec, patterns)) return;
    const resolved = resolveImportSpecifierToAbsPath(projectRoot, relImporter, spec);
    if (resolved) return;
    const key = `${relImporter}::${line}::${spec}`;
    if (!missing.has(key)) {
      missing.set(key, { file: relImporter, line, spec });
    }
  };

  for (const sf of sourceFiles) {
    const abs = sf.getFilePath();
    const relImporter = toProjectRelative(projectRoot, abs);

    for (const decl of sf.getImportDeclarations()) {
      if (decl.isTypeOnly()) continue;
      const spec = decl.getModuleSpecifierValue();
      if (!spec) continue;
      const line =
        decl.getModuleSpecifier()?.getStartLineNumber() ??
        decl.getStartLineNumber();
      recordMissing(relImporter, line, spec);
    }

    for (const decl of sf.getExportDeclarations()) {
      if (typeof decl.isTypeOnly === 'function' && decl.isTypeOnly()) continue;
      const spec = decl.getModuleSpecifierValue();
      if (!spec) continue;
      const line =
        decl.getModuleSpecifier()?.getStartLineNumber() ??
        decl.getStartLineNumber();
      recordMissing(relImporter, line, spec);
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.Identifier) continue;
      if (expr.getText() !== 'import') continue;
      const args = call.getArguments();
      const a0 = args[0];
      if (!a0 || a0.getKind() !== SyntaxKind.StringLiteral) continue;
      const spec = a0.getLiteralValue();
      recordMissing(relImporter, a0.getStartLineNumber(), spec);
    }
  }

  const missingList = [...missing.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.spec.localeCompare(b.spec),
  );

  return {
    ran: true,
    scannedFiles: sourceFiles.length,
    missing: missingList,
  };
}

/**
 * @param {string} projectRoot
 * @param {{ missing: Array<{ file: string, line: number, spec: string }> }} scan
 */
async function writeStaticImportReport(projectRoot, scan) {
  const reportPath = path.join(projectRoot, REPORT_FILE);
  const lines = [
    '# Nextify static import / asset resolution report',
    `# generated at: ${new Date().toISOString()}`,
    `# project: ${projectRoot}`,
    `# scanned source files: ${scan.scannedFiles ?? 0}`,
    `# missing (relative or tsconfig paths only): ${scan.missing.length}`,
    '#',
    '# These imports do not resolve to an existing file on disk.',
    '# TypeScript may still pass if wildcard module declarations hide them.',
    '# Fix by restoring assets, correcting paths, or aligning tsconfig paths.',
    '',
  ];
  for (const m of scan.missing) {
    lines.push(`${m.file}:${m.line}: cannot resolve ${m.spec}`);
  }
  lines.push('');
  try {
    await fs.writeFile(reportPath, lines.join('\n'), 'utf-8');
  } catch {
    return null;
  }
  return reportPath;
}

module.exports = {
  runStaticImportScan,
  writeStaticImportReport,
  REPORT_FILE,
};
