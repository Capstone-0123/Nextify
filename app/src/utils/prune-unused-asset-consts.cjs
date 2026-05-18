// app/src/utils/prune-unused-asset-consts.cjs
//
// step4/asset-migrator 가 `import X from '../../assets/...svg'` 를
// `const X = '/assets/....svg';` 로 변환한 뒤, 다른 마이그레이터
// (예: step7/next-image-migrator) 가 `<img src={X}>` 를
// `<Image src="/assets/....svg" />` 같이 *리터럴 문자열*로 인라이닝하면
// 결과적으로 X 가 사용처 0 인 죽은 변수로 남아 `next build` 의
// type-check 가 TS6133 ('X' is declared but its value is never read.)
// 으로 실패하는 사고를 막기 위한 결정론적 sweep.
//
// 안전 기준:
//   - `const NAME = '/assets/...';` 단일 라인 선언만 대상으로 한다.
//     (블록·구조분해·여러 줄 선언은 건드리지 않는다.)
//   - 같은 파일 안에서 NAME 의 다른 등장이 0 회이면 선언 줄을 통째로 삭제한다.
//   - 다른 파일/스코프는 신경 쓰지 않는다 (선언은 파일 상단 모듈 스코프에서만 만들어지며
//     해당 파일에서 사용되지 않으면 외부에서 import 도 불가하기 때문).

const fs = require('fs-extra');
const path = require('path');

let _ts = null;
function getTs() {
  if (_ts) return _ts;
  try {
    _ts = require('typescript');
  } catch {
    _ts = null;
  }
  return _ts;
}

function pickScriptKind(ts, ext) {
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * 파일 텍스트에서 *식별자 노드*들의 텍스트만 모은다.
 * 문자열 리터럴·주석·JSX 텍스트 등은 식별자가 아니므로 자연스럽게 제외된다.
 * AST 가 만들어지지 않으면 null 반환 → 호출자가 fallback 휴리스틱으로 결정.
 *
 * @param {string} relPath
 * @param {string} text
 * @returns {Set<string> | null}
 */
function collectIdentifierNames(relPath, text) {
  const ts = getTs();
  if (!ts) return null;
  const ext = path.extname(relPath).toLowerCase();
  const kind = pickScriptKind(ts, ext);
  if (kind === ts.ScriptKind.Unknown) return null;
  let sf;
  try {
    sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, false, kind);
  } catch {
    return null;
  }
  /** @type {Set<string>} */
  const names = new Set();
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.Identifier) {
      // node.escapedText 는 prefixed name 일 수 있어 node.text 우선.
      const t = node.text || (node.escapedText && String(node.escapedText));
      if (t) names.add(t);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  '.ai-migration',
  '__nextify_snapshots',
]);

// ^[ \t]* const NAME = '/assets/...';   (한 줄)
const ASSET_CONST_LINE_RE =
  /^[ \t]*const\s+([A-Za-z_$][\w$]*)\s*=\s*['"]\/assets\/[^'"]+['"]\s*;?[ \t]*$/;

async function walkSrcFiles(root) {
  /** @type {string[]} */
  const out = [];
  async function recur(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await recur(path.join(dir, e.name));
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (CODE_EXTS.has(ext)) out.push(path.join(dir, e.name));
      }
    }
  }
  await recur(root);
  return out;
}

/**
 * 파일 안에서 `const X = '/assets/...';` 단일 라인 선언 중
 * X 가 같은 파일 어디에서도 다시 사용되지 않는 것을 모두 삭제한다.
 *
 * @param {string} filePath
 * @returns {Promise<{ removed: string[] }>}
 */
async function pruneFile(filePath) {
  const before = await fs.readFile(filePath, 'utf8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);

  // 1) 후보 라인 수집
  /** @type {{ index: number, name: string }[]} */
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ASSET_CONST_LINE_RE.exec(lines[i]);
    if (m) candidates.push({ index: i, name: m[1] });
  }
  if (candidates.length === 0) return { removed: [] };

  // 2) 사용처 확인을 위한 기준 텍스트 = 후보 라인을 빈 줄로 치환한 사본
  //    (후보 라인 자체에 NAME 이 등장하므로 카운트에서 제외해야 함)
  const lookupLines = lines.slice();
  for (const c of candidates) lookupLines[c.index] = '';
  const lookupText = lookupLines.join('\n');

  // ── AST 기반 1차 판정 ───────────────────────────────────────────────
  // typescript parser 로 *식별자 노드* 의 이름 집합만 만든다.
  // 문자열 리터럴 안의 `/submit.svg` 같은 단어가 사용처로 오인되는
  // 케이스를 방지하기 위해 정규식 휴리스틱보다 우선한다.
  const idNames = collectIdentifierNames(filePath, lookupText);

  /** @type {string[]} */
  const removedNames = [];
  /** @type {Set<number>} */
  const removeIndices = new Set();
  for (const c of candidates) {
    let used;
    if (idNames) {
      used = idNames.has(c.name);
    } else {
      // AST 를 못 만들면 정규식 fallback (보수적: 사용처가 보이면 보존)
      const re = new RegExp(`(^|[^A-Za-z0-9_$])${c.name}(?=[^A-Za-z0-9_$]|$)`);
      used = re.test(lookupText);
    }
    // ── 추가 안전망: JSX 컴포넌트로 사용되는 식별자는 *절대* 미사용으로 분류하지 않는다.
    //   (e.g. `<MapIcon />`, `<MapIcon className=...>`, `<MapIcon\n .../>` 등)
    //   AST 가 부분 파싱에 실패해 idNames 가 누락된 경우라도 여기서 보존된다.
    if (!used) {
      const jsxRe = new RegExp(`<\\s*${c.name}(?=[\\s/>])`);
      if (jsxRe.test(lookupText)) used = true;
    }
    if (!used) {
      removeIndices.add(c.index);
      removedNames.push(c.name);
    }
  }

  if (removeIndices.size === 0) return { removed: [] };

  const kept = lines.filter((_, i) => !removeIndices.has(i));
  const after = kept.join(eol);
  if (after !== before) {
    await fs.writeFile(filePath, after, 'utf8');
  }
  return { removed: removedNames };
}

/**
 * 프로젝트 전체에서 미사용 asset const 를 정리한다.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ totalRemoved: number, changedFiles: { file: string, removed: string[] }[] }>}
 */
async function pruneUnusedAssetConsts(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  if (!(await fs.pathExists(srcDir))) {
    return { totalRemoved: 0, changedFiles: [] };
  }

  const files = await walkSrcFiles(srcDir);
  const changedFiles = [];
  let totalRemoved = 0;
  for (const f of files) {
    try {
      const { removed } = await pruneFile(f);
      if (removed.length > 0) {
        changedFiles.push({ file: path.relative(projectRoot, f), removed });
        totalRemoved += removed.length;
      }
    } catch {
      // ignore single-file errors so 한 파일 실패가 전체를 막지 않게 한다.
    }
  }
  return { totalRemoved, changedFiles };
}

module.exports = {
  pruneUnusedAssetConsts,
};
