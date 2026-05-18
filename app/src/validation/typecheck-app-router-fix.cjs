'use strict';

// Step7 typecheck 결정론 보조: App Router 와 맞지 않는 react-router 잔재를 고친다.
// - useRouter() 로 받은 인스턴스(이름이 router 가 아니어도)에 동일 규칙 적용
// - router.push/replace({ pathname, query }) → 문자열 href + URLSearchParams
// - *.push(url, { replace | state }) → replace 호출 + sessionStorage(state)
// - useLocation() → usePathname + useSearchParams + sessionStorage 기반 state
// - 누락된 next/image Image import, * as R 스타일 네임스페이스 import
// - JSX 속성 중복 제거 (TS17001)

const fs = require('fs-extra');
const path = require('path');
const { SyntaxKind } = require('ts-morph');

const RR_STATE_KEY = '__nextify_rr_state';

function unwrapExpression(node) {
  let e = node;
  for (let i = 0; i < 10; i++) {
    if (!e) break;
    const k = e.getKind();
    if (k === SyntaxKind.ParenthesizedExpression) {
      e = e.getExpression();
      continue;
    }
    if (k === SyntaxKind.AsExpression || k === SyntaxKind.TypeAssertionExpression) {
      e = e.getExpression();
      continue;
    }
    if (k === SyntaxKind.NonNullExpression) {
      e = e.getExpression();
      continue;
    }
    break;
  }
  return e;
}

/**
 * `router` 관용명 + `const x = useRouter()` 로 바인딩된 모든 수신자
 */
function getAppRouterInstanceNames(sourceFile) {
  const names = new Set(['router']);
  for (const stmt of sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement)) {
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer();
      if (!init || init.getKind() !== SyntaxKind.CallExpression) continue;
      if (init.getExpression().getText() !== 'useRouter') continue;
      names.add(decl.getName());
    }
  }
  return names;
}

function receiverIsAppRouterInstance(pa, instanceNames) {
  const left = unwrapExpression(pa.getExpression());
  return left.getKind() === SyntaxKind.Identifier && instanceNames.has(left.getText());
}

/**
 * Next.js: "use client" | "use server" 는 파일 최상단(주석 제외)에 와야 함.
 * import 앞에 오는 경우도 있으므로 둘 다 선행한 뒤에 삽입한다.
 */
function isModuleDirectiveStatement(stmt) {
  if (stmt.getKind() !== SyntaxKind.ExpressionStatement) return false;
  const expr = stmt.getExpression();
  if (expr.getKind() !== SyntaxKind.StringLiteral) return false;
  const t = expr.getLiteralText();
  return t === 'use client' || t === 'use server';
}

function insertAfterImports(sourceFile, text) {
  const stmts = sourceFile.getStatements();
  let i = 0;
  for (; i < stmts.length; i++) {
    const k = stmts[i].getKind();
    if (k === SyntaxKind.ImportDeclaration) continue;
    if (isModuleDirectiveStatement(stmts[i])) continue;
    break;
  }
  sourceFile.insertStatements(i, text);
}

/**
 * 로컬 상대 경로에 모듈이 없고, named import 가 알려진 npm 패키지와 1:1 대응될 때만 교체.
 * 다른 마이그레이션에 재사용하려면 아래 Map 에만 심볼→패키지 를 추가하면 됨.
 */
const KNOWN_NAMED_IMPORT_TO_PACKAGE = new Map([
  ['useKakaoLoader', 'react-kakao-maps-sdk'],
]);

function fixKnownLibraryFallbackImports(sourceFile, absPath) {
  let n = 0;
  const dir = path.dirname(absPath);
  for (const imp of sourceFile.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec || (!spec.startsWith('.') && !spec.startsWith('..'))) continue;
    const named = imp.getNamedImports();
    if (named.length === 0) continue;
    const pkgs = new Set();
    for (const sp of named) {
      const pkg = KNOWN_NAMED_IMPORT_TO_PACKAGE.get(sp.getName());
      if (pkg) pkgs.add(pkg);
    }
    if (pkgs.size !== 1) continue;
    const pkg = [...pkgs][0];
    if (!named.every((sp) => KNOWN_NAMED_IMPORT_TO_PACKAGE.has(sp.getName()))) continue;
    if (spec === pkg) continue;
    const resolvedBase = path.normalize(path.join(dir, spec));
    const tryPaths = [
      resolvedBase,
      `${resolvedBase}.ts`,
      `${resolvedBase}.tsx`,
      `${resolvedBase}.cjs`,
      `${resolvedBase}.js`,
    ];
    if (tryPaths.some((p) => fs.existsSync(p))) continue;
    imp.setModuleSpecifier(pkg);
    n++;
  }
  return n;
}

/**
 * ./Foo.styled 모듈이 없으면 ./FooStyle|FooStyles 등 동일 디렉터리 후보로 교체
 */
function fixWrongStyledImports(sourceFile, absPath) {
  let n = 0;
  const dir = path.dirname(absPath);
  for (const imp of sourceFile.getImportDeclarations()) {
    let spec = imp.getModuleSpecifierValue();
    if (!spec || !spec.startsWith('.')) continue;
    spec = spec.replace(/\?.*$/, '');
    const baseName = path.basename(spec);
    const stem = baseName.replace(/\.styled(\.(tsx|ts|jsx|js))?$/, '');
    if (stem === baseName) continue;
    const resolved = path.join(dir, baseName);
    const existsStyled =
      fs.existsSync(resolved) ||
      fs.existsSync(`${resolved}.ts`) ||
      fs.existsSync(`${resolved}.tsx`);
    if (existsStyled) continue;
    const candidates = [`${stem}Style`, `${stem}Styles`, `${stem}.styles`];
    for (const c of candidates) {
      if (fs.existsSync(path.join(dir, `${c}.tsx`)) || fs.existsSync(path.join(dir, `${c}.ts`))) {
        imp.setModuleSpecifier(`./${c}`);
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * public/.../*.svg default import → URL 문자열 상수 (TS 모듈 선언 불필요)
 */
function fixPublicSvgDefaultImport(sourceFile) {
  let n = 0;
  const imps = [...sourceFile.getImportDeclarations()];
  for (const imp of imps) {
    const spec = imp.getModuleSpecifierValue();
    if (!spec || !spec.includes('public')) continue;
    if (!/\.svg(\?|$)/i.test(spec)) continue;
    const def = imp.getDefaultImport();
    if (!def) continue;
    const norm = spec.replace(/\\/g, '/');
    const pub = '/public/';
    const idx = norm.indexOf(pub);
    if (idx === -1) continue;
    const sub = norm.slice(idx + pub.length).split('?')[0];
    if (!sub.toLowerCase().endsWith('.svg')) continue;
    const url = `/${sub}`;
    const name = def.getText();
    imp.remove();
    insertAfterImports(sourceFile, `const ${name} = "${url}";\n`);
    n++;
  }
  return n;
}

/**
 * React Router location state 잔재: navState 가 항상 undefined 인데 optional chaining 으로
 * 꺼내 never/충돌이 나는 패턴. (프로젝트 공통 마이그레이션 부작용)
 */
function fixNavStateOptionalNever(sourceFile) {
  const text = sourceFile.getFullText();
  if (!/\bnavState\?\./.test(text)) return 0;
  const next = text.replace(
    /\b(?:const|let)\s+from\s*=\s*navState\?\.from\s*;?/g,
    'const from: string | undefined = undefined;',
  );
  if (next === text) return 0;
  sourceFile.replaceWithText(next);
  return 1;
}

function ensureNamedImports(sourceFile, moduleSpecifier, names) {
  const need = [...names];
  let decl = sourceFile.getImportDeclaration((d) => d.getModuleSpecifierValue() === moduleSpecifier);
  if (!decl) {
    sourceFile.addImportDeclaration({
      moduleSpecifier,
      namedImports: need,
    });
    return;
  }
  for (const n of need) {
    if (!decl.getNamedImports().some((x) => x.getName() === n)) {
      decl.addNamedImport(n);
    }
  }
}

function removeUseLocationFromReactRouter(sourceFile) {
  let touched = 0;
  for (const imp of sourceFile.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== 'react-router-dom') continue;
    const spec = imp.getNamedImports().find((n) => n.getName() === 'useLocation');
    if (!spec) continue;
    spec.remove();
    touched++;
    if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport()) {
      imp.remove();
    }
  }
  return touched;
}

/**
 * const x = useLocation() / let x = useLocation()
 */
function replaceUseLocationVariableDeclarations(sourceFile) {
  let n = 0;
  const stmts = sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement);
  for (const stmt of stmts) {
    const decls = stmt.getDeclarationList().getDeclarations();
    if (decls.length !== 1) continue;
    const decl = decls[0];
    const init = decl.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.CallExpression) continue;
    if (init.getExpression().getText() !== 'useLocation') continue;

    const varName = decl.getName();
    ensureNamedImports(sourceFile, 'next/navigation', ['usePathname', 'useSearchParams']);
    removeUseLocationFromReactRouter(sourceFile);

    stmt.replaceWithText(
      `const pathname = usePathname();\n  const searchParams = useSearchParams();\n  const ${varName} = {\n    pathname: pathname ?? "",\n    search: searchParams?.toString() ? \`?\${searchParams}\` : "",\n    hash: "",\n    key: "default",\n    state: (() => {\n      if (typeof window === "undefined") return undefined;\n      try {\n        const raw = sessionStorage.getItem("${RR_STATE_KEY}");\n        return raw ? JSON.parse(raw) : undefined;\n      } catch {\n        return undefined;\n      }\n    })(),\n  };`,
    );
    n++;
  }
  return n;
}

/**
 * const { state } = useLocation() as { state: LocationState }
 */
function replaceDestructuredUseLocation(sourceFile) {
  let n = 0;
  const stmts = sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement);
  for (const stmt of stmts) {
    const decls = stmt.getDeclarationList().getDeclarations();
    if (decls.length !== 1) continue;
    const decl = decls[0];
    const nameNode = decl.getNameNode();
    if (nameNode.getKind() !== SyntaxKind.ObjectBindingPattern) continue;
    const elements = nameNode.getElements();
    if (elements.length !== 1) continue;
    const bindName = elements[0].getNameNode().getText();
    if (bindName !== 'state') continue;

    const init = decl.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.AsExpression) continue;
    const inner = init.getExpression();
    if (!inner || inner.getKind() !== SyntaxKind.CallExpression) continue;
    if (inner.getExpression().getText() !== 'useLocation') continue;

    ensureNamedImports(sourceFile, 'next/navigation', ['usePathname', 'useSearchParams']);
    removeUseLocationFromReactRouter(sourceFile);

    stmt.replaceWithText(
      `const pathname = usePathname();\nconst searchParams = useSearchParams();\nvoid pathname;\nvoid searchParams;\nconst state = (() => {\n  if (typeof window === "undefined") return undefined;\n  try {\n    const raw = sessionStorage.getItem("${RR_STATE_KEY}");\n    return raw ? JSON.parse(raw) : undefined;\n  } catch {\n    return undefined;\n  }\n})() as LocationState | undefined;`,
    );
    n++;
  }
  return n;
}

function ensureLocationStateAlias(sourceFile) {
  const text = sourceFile.getFullText();
  if (!/\bLocationState\b/.test(text)) return 0;
  if (/type\s+LocationState\b/.test(text) || /interface\s+LocationState\b/.test(text)) return 0;
  const imports = sourceFile.getImportDeclarations();
  const alias =
    'type LocationState = Record<string, unknown> & {\n  source?: string;\n  setup?: boolean;\n  selected?: string;\n  sigCode?: string;\n  districtId?: string;\n};\n';
  if (imports.length > 0) {
    imports[imports.length - 1].insertAfter(alias);
  } else {
    sourceFile.insertStatements(0, alias);
  }
  return 1;
}

/**
 * router.push({ pathname, query }) / router.replace({ pathname, query })
 */
function fixRouterObjectHrefCalls(sourceFile) {
  const instanceNames = getAppRouterInstanceNames(sourceFile);
  let n = 0;
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of [...calls].reverse()) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const pa = expr;
    const method = pa.getName();
    if (method !== 'push' && method !== 'replace') continue;
    if (!receiverIsAppRouterInstance(pa, instanceNames)) continue;
    const args = call.getArguments();
    if (args.length !== 1) continue;
    const first = args[0];
    if (first.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
    const obj = first;
    const pathnameProp = obj.getProperty('pathname');
    if (!pathnameProp || pathnameProp.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const pathnameInit = pathnameProp.getInitializer();
    if (!pathnameInit) continue;
    const queryProp = obj.getProperty('query');
    let hrefExpr;
    if (
      queryProp &&
      queryProp.getKind() === SyntaxKind.PropertyAssignment &&
      queryProp.getInitializer()?.getKind() === SyntaxKind.ObjectLiteralExpression
    ) {
      const qObj = queryProp.getInitializer();
      const parts = [];
      for (const p of qObj.getProperties()) {
        if (p.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const key = p.getName();
        const qi = p.getInitializer();
        if (!qi) continue;
        parts.push(`${JSON.stringify(key)}: String(${qi.getText()})`);
      }
      hrefExpr = `(${pathnameInit.getText()}) + '?' + new URLSearchParams({ ${parts.join(', ')} }).toString()`;
    } else {
      hrefExpr = pathnameInit.getText();
    }
    const recv = unwrapExpression(pa.getExpression()).getText();
    call.replaceWithText(`${recv}.${method}(${hrefExpr})`);
    n++;
  }
  return n;
}

/**
 * router.push(url, { replace: true }) → router.replace(url)
 * router.push(url, { state: x }) → sessionStorage + router.push(url)
 */
function fixRouterSecondOptionsArg(sourceFile) {
  const instanceNames = getAppRouterInstanceNames(sourceFile);
  let n = 0;
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of [...calls].reverse()) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const pa = expr;
    const method = pa.getName();
    if (method !== 'push' && method !== 'replace') continue;
    if (!receiverIsAppRouterInstance(pa, instanceNames)) continue;
    const args = call.getArguments();
    if (args.length !== 2) continue;
    const second = args[1];
    if (second.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
    const obj = second;
    let replaceTrue = false;
    let stateInit = null;
    for (const p of obj.getProperties()) {
      if (p.getKind() === SyntaxKind.PropertyAssignment) {
        if (p.getName() === 'replace' && p.getInitializer()?.getText() === 'true') replaceTrue = true;
        if (p.getName() === 'state') stateInit = p.getInitializer();
      } else if (p.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
        if (p.getName() === 'state') stateInit = p;
      }
    }
    if (!replaceTrue && !stateInit) continue;
    const firstText = args[0].getText();
    const finalMethod = replaceTrue || method === 'replace' ? 'replace' : 'push';
    let prefix = '';
    if (stateInit) {
      const stateExpr = stateInit.getText();
      prefix = `try { if (typeof window !== "undefined") sessionStorage.setItem("${RR_STATE_KEY}", JSON.stringify(${stateExpr})); } catch {} `;
    }
    const recv = unwrapExpression(pa.getExpression()).getText();
    call.replaceWithText(`${prefix}${recv}.${finalMethod}(${firstText})`);
    n++;
  }
  return n;
}

/**
 * const navigate = useNavigate(); navigate(url, { state, replace }) — App Router 타입과 동일 패턴으로 보정
 */
function collectUseNavigateBindingNames(sourceFile) {
  const names = new Set();
  for (const stmt of sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement)) {
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer();
      if (!init || init.getKind() !== SyntaxKind.CallExpression) continue;
      if (init.getExpression().getText() !== 'useNavigate') continue;
      names.add(decl.getName());
    }
  }
  return names;
}

function fixNavigateSecondOptionsArg(sourceFile) {
  const navNames = collectUseNavigateBindingNames(sourceFile);
  if (navNames.size === 0) return 0;
  let n = 0;
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of [...calls].reverse()) {
    const expr = unwrapExpression(call.getExpression());
    if (expr.getKind() !== SyntaxKind.Identifier) continue;
    if (!navNames.has(expr.getText())) continue;
    const args = call.getArguments();
    if (args.length !== 2) continue;
    const second = args[1];
    if (second.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
    const obj = second;
    let replaceTrue = false;
    let stateInit = null;
    for (const p of obj.getProperties()) {
      if (p.getKind() === SyntaxKind.PropertyAssignment) {
        if (p.getName() === 'replace' && p.getInitializer()?.getText() === 'true') replaceTrue = true;
        if (p.getName() === 'state') stateInit = p.getInitializer();
      } else if (p.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
        if (p.getName() === 'state') stateInit = p;
      }
    }
    if (!replaceTrue && !stateInit) continue;
    const firstText = args[0].getText();
    const navName = expr.getText();
    let prefix = '';
    if (stateInit) {
      const stateExpr = stateInit.getText();
      prefix = `try { if (typeof window !== "undefined") sessionStorage.setItem("${RR_STATE_KEY}", JSON.stringify(${stateExpr})); } catch {} `;
    }
    const tail = replaceTrue ? `${navName}(${firstText}, { replace: true })` : `${navName}(${firstText})`;
    call.replaceWithText(`${prefix}${tail}`);
    n++;
  }
  return n;
}

function hasNamespaceImportR(sourceFile) {
  return sourceFile.getImportDeclarations().some((d) => {
    const ns = d.getNamespaceImport();
    return ns && ns.getName() === 'R';
  });
}

function ensureRStyleNamespace(sourceFile, absPath, relPath) {
  const text = sourceFile.getFullText();
  if (!/\bR\./.test(text)) return 0;
  if (hasNamespaceImportR(sourceFile)) return 0;

  const dir = path.dirname(absPath);
  const base = path.basename(relPath, path.extname(relPath));
  const candidates = [
    path.join(dir, `${base}Style.tsx`),
    path.join(dir, `${base}Style.ts`),
    path.join(dir, `${base}Styles.tsx`),
    path.join(dir, `${base}.styles.tsx`),
    path.join(dir, `${base}.styles.ts`),
  ];
  let found = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      found = c;
      break;
    }
  }
  if (!found) return 0;

  const relMod =
    './' +
    path.basename(found).replace(/\.(tsx|ts)$/, '');
  sourceFile.addImportDeclaration({
    moduleSpecifier: relMod,
    namespaceImport: 'R',
  });
  return 1;
}

function ensureNextImageDefaultImport(sourceFile) {
  const text = sourceFile.getFullText();
  if (!/<\s*Image\b/.test(text)) return 0;
  const has = sourceFile.getImportDeclarations().some(
    (d) => d.getModuleSpecifierValue() === 'next/image',
  );
  if (has) return 0;
  sourceFile.addImportDeclaration({
    defaultImport: 'Image',
    moduleSpecifier: 'next/image',
  });
  return 1;
}

function removeDuplicateJsxAttributes(sourceFile) {
  let n = 0;
  const nodes = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
  ];
  for (const el of nodes) {
    const attrs = el.getAttributes();
    const seen = new Set();
    for (const attr of [...attrs]) {
      if (attr.getKind() !== SyntaxKind.JsxAttribute) continue;
      const name = attr.getNameNode().getText();
      if (seen.has(name)) {
        attr.remove();
        n++;
      } else {
        seen.add(name);
      }
    }
  }
  return n;
}

/**
 * @param {import('ts-morph').SourceFile} sourceFile
 * @param {string} projectRoot
 * @param {string} relPath
 * @returns {number} 적용한 변환 횟수(대략적)
 */
function applyAppRouterFixes(sourceFile, projectRoot, relPath) {
  const absPath = path.join(projectRoot, relPath);
  let total = 0;

  total += fixKnownLibraryFallbackImports(sourceFile, absPath);
  total += fixWrongStyledImports(sourceFile, absPath);
  total += fixPublicSvgDefaultImport(sourceFile);
  total += fixNavStateOptionalNever(sourceFile);
  total += ensureLocationStateAlias(sourceFile);
  total += fixRouterObjectHrefCalls(sourceFile);
  total += fixRouterSecondOptionsArg(sourceFile);
  total += fixNavigateSecondOptionsArg(sourceFile);
  total += replaceUseLocationVariableDeclarations(sourceFile);
  total += replaceDestructuredUseLocation(sourceFile);
  total += ensureRStyleNamespace(sourceFile, absPath, relPath);
  total += ensureNextImageDefaultImport(sourceFile);
  total += removeDuplicateJsxAttributes(sourceFile);

  return total;
}

module.exports = {
  applyAppRouterFixes,
  RR_STATE_KEY,
  /** 결정론 import 폴백 확장 시 Map 에 항목 추가 */
  KNOWN_NAMED_IMPORT_TO_PACKAGE,
};
