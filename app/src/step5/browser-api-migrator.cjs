// app/src/step5/browser-api-migrator.cjs
// 브라우저 API 최상단 접근 탐지 및 SSR-safe 변환

const fs = require('fs-extra');
const path = require('path');

const BROWSER_GLOBALS = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator'];

// ---------------------------------------------------------------------------
// 1) 대상 파일 수집
// ---------------------------------------------------------------------------
async function findTsFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;

  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      files.push(...(await findTsFiles(fullPath)));
    } else if (/\.(ts|tsx|js|jsx)$/.test(item.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// 2) 모듈 최상단 라인 인덱스 (함수/클래스 선언 전까지)
// ---------------------------------------------------------------------------
function getTopLevelLineIndices(content) {
  const lines = content.split('\n');
  const indices = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      indices.push(i);
      continue;
    }
    // import / 'use client' / 주석 → 최상단
    if (/^(\/\/|\/\*|\*|'use strict'|"use client"|'use client')/.test(trimmed)) {
      indices.push(i);
      continue;
    }
    if (/^\s*import\s+/.test(lines[i])) {
      indices.push(i);
      continue;
    }
    // export const/let/var (모듈 최상단 변수) → 최상단
    if (/^export\s+(const|let|var)\s+\w+/.test(trimmed) || /^(const|let|var)\s+\w+/.test(trimmed)) {
      indices.push(i);
      continue;
    }
    // 함수/클래스 선언 시작이면 여기서부터는 최상단 아님
    if (/^(export\s+)?(default\s+)?(function|class|async\s+function)\s/.test(trimmed)) break;
    if (/^(export\s+)?(default\s+)?\w+.*=\s*(\([^)]*\)\s*=>|async\s*\([^)]*\)\s*=>)/.test(trimmed)) break;
    indices.push(i);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// 3) 최상단 브라우저 글로벌 접근 탐지
// ---------------------------------------------------------------------------
function analyzeTopLevelBrowserAccess(content, filePath) {
  const issues = [];
  const lines = content.split('\n');
  const topLevel = new Set(getTopLevelLineIndices(content));
  const fileName = path.basename(filePath);

  for (let i = 0; i < lines.length; i++) {
    if (!topLevel.has(i)) continue;
    const line = lines[i];

    for (const g of BROWSER_GLOBALS) {
      const re = new RegExp(`\\b${g}\\.`, 'g');
      if (re.test(line)) {
        issues.push({
          type: 'top_level_browser_global',
          global: g,
          lineIndex: i,
          line,
          filePath,
          fileName,
        });
        break;
      }
    }

    if (/createRoot\s*\(\s*document\.getElementById/.test(line) && /main\.(tsx|jsx)$/.test(fileName)) {
      issues.push({ type: 'create_root_document', lineIndex: i, line, filePath, fileName });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 4) 단순 읽기 한 줄 변환: const x = window.xxx → typeof guard ? xxx : default
// ---------------------------------------------------------------------------
function transformOneLineBrowserRead(line, globalName) {
  const guard =
    globalName === 'document'
      ? "typeof document !== 'undefined'"
      : "typeof window !== 'undefined'";
  const defaultVal =
    globalName === 'localStorage' || globalName === 'sessionStorage' ? "''" : '0';

  const match = line.match(/^(\s*)((?:export\s+)?)(const|let|var)\s+(\w+)\s*=\s*(.+?)\s*;?\s*$/);
  if (!match) return line;
  const [, indent, exportPrefix, keyword, name, expr] = match;
  if (!new RegExp(`\\b${globalName}\\.`).test(expr)) return line;
  const newExpr = `${guard} ? (${expr.replace(/;\s*$/, '').trim()}) : ${defaultVal}`;
  return `${indent}${exportPrefix}${keyword} ${name} = ${newExpr};`;
}

// ---------------------------------------------------------------------------
// 5) 상수 파일: SCREEN_WIDTH = window.innerWidth → IS_BROWSER ? ... : 0
// ---------------------------------------------------------------------------
function transformConstantsFile(content) {
  let next = content;
  const hasIsBrowser =
    /IS_BROWSER\s*=\s*typeof\s+window/.test(next) || /export\s+const\s+IS_BROWSER/.test(next);
  const guard = hasIsBrowser ? 'IS_BROWSER' : "typeof window !== 'undefined'";

  next = next.replace(
    /(\b)(window\.innerWidth|window\.innerHeight)(\s*\|\|\s*0)?/g,
    (_, before, expr) => `${before}${guard} ? ${expr} : 0`
  );
  return next;
}

// ---------------------------------------------------------------------------
// 6) main.tsx / main.jsx: createRoot(document.getElementById...) 래핑
// ---------------------------------------------------------------------------
function transformCreateRoot(content) {
  if (/if\s*\(\s*typeof\s+window\s*!==\s*['"]undefined['"]\s*\)\s*\{[\s\S]*createRoot/.test(content))
    return content;

  const lines = content.split('\n');
  let start = -1;
  let end = -1;
  let parenDepth = 0;
  let renderCall = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/document\.getElementById\s*\([\s\S]*\)\s*!?;?/.test(line) && start === -1) {
      start = i;
    }
    if (start === -1) continue;
    if (/createRoot\s*\(/.test(line)) renderCall = true;
    if (renderCall && /\.render\s*\(/.test(line)) {
      end = i;
      parenDepth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        parenDepth += (l.match(/\(/g) || []).length - (l.match(/\)/g) || []).length;
        if (parenDepth <= 0 && /\)\s*;?\s*$/.test(l)) {
          end = j;
          break;
        }
      }
      break;
    }
  }

  if (start < 0 || end < 0) return content;

  const indent = lines[start].match(/^(\s*)/)[1];
  const rootLine = lines[start];
  const rootIdMatch = rootLine.match(/getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  const rootId = rootIdMatch ? rootIdMatch[1] : 'root';

  const blockLines = lines.slice(start, end + 1);
  const innerLines = blockLines.slice(1).map((l) => indent + '    ' + l.trimStart());
  const innerContent = innerLines
    .join('\n')
    .replace(/createRoot\s*\(\s*\w+\s*\)/, 'createRoot(rootElement)');

  const newBlock =
    `${indent}if (typeof window !== 'undefined') {\n` +
    `${indent}  const rootElement = document.getElementById('${rootId}');\n` +
    `${indent}  if (rootElement) {\n` +
    innerContent +
    `\n${indent}  }\n` +
    `${indent}}`;

  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end + 1).join('\n');
  return before + '\n' + newBlock + (after ? '\n' + after : '');
}

// ---------------------------------------------------------------------------
// 7) 파일별 변환 적용
// ---------------------------------------------------------------------------
function applyTransformations(content, issues, filePath) {
  let next = content;
  const fileName = path.basename(filePath);
  const lines = next.split('\n');

  const globalByLine = new Map();
  for (const issue of issues) {
    if (issue.type === 'top_level_browser_global') {
      const idx = issue.lineIndex;
      if (!globalByLine.has(idx)) globalByLine.set(idx, issue.global);
    }
  }

  for (const [lineIndex, globalName] of globalByLine) {
    lines[lineIndex] = transformOneLineBrowserRead(lines[lineIndex], globalName);
  }
  next = lines.join('\n');

  if (fileName === 'constants.ts' || fileName === 'constants.js') {
    next = transformConstantsFile(next);
  }
  if (fileName === 'main.tsx' || fileName === 'main.jsx') {
    next = transformCreateRoot(next);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 8) 메인: migrateBrowserAPIs(projectRoot)
// ---------------------------------------------------------------------------
async function migrateBrowserAPIs(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) {
    return { totalFiles: 0, processedFiles: [], reported: [] };
  }

  const files = await findTsFiles(srcDir);
  const processedFiles = [];
  const reported = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, 'utf-8');
    const issues = analyzeTopLevelBrowserAccess(content, filePath);
    if (issues.length === 0) continue;

    reported.push({ filePath: path.relative(projectRoot, filePath), issues });
    const newContent = applyTransformations(content, issues, filePath);
    if (newContent !== content) {
      await fs.writeFile(filePath, newContent, 'utf-8');
      processedFiles.push(path.relative(projectRoot, filePath));
    }
  }

  return { totalFiles: files.length, processedFiles, reported };
}

module.exports = {
  migrateBrowserAPIs,
  analyzeTopLevelBrowserAccess,
  getTopLevelLineIndices,
};
