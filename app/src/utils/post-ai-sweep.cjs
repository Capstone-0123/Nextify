'use strict';

// app/src/utils/post-ai-sweep.cjs
// Gemini가 적용한 파일 직후 결정론적(LLM 호출 없는) 후처리.
// - 토큰 비용 0
// - 파일당 ts-morph AST 분석 + 안전한 패턴만 제거
// 모든 Gemini 적용 통로(runAskApply)에서 1회 호출되어 dead code/메타-주석을 정리합니다.

const fs = require('fs-extra');
const path = require('path');
const { Project, SyntaxKind } = require('ts-morph');

// ---- 상수 ------------------------------------------------------------------

const BROWSER_GLOBAL_NAMES = new Set([
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'self',
]);

// AI가 자기 의도를 설명하느라 흔히 박는 메타-주석 한 줄 패턴들.
// 코드 동작과 무관하고 사용자가 보기에 혼란만 주므로 결정론적으로 제거.
const AI_META_COMMENT_PATTERNS = [
  /^[ \t]*\/\/\s*Intentional SSR-breaking[^\n]*\r?\n/gm,
  /^[ \t]*\/\/\s*Moved to useEffect to be SSR-safe[^\n]*\r?\n/gm,
  /^[ \t]*\/\/\s*SSR-safe[^\n]*\r?\n/gm,
  /^[ \t]*\/\/\s*browser only[^\n]*\r?\n/gm,
  /^[ \t]*\/\/\s*guarded by typeof window[^\n]*\r?\n/gm,
];

// 처리 대상 확장자
const SUPPORTED_EXT = /\.(t|j)sx?$/;

// ---- Server Component 판정 ------------------------------------------------

/**
 * 파일 본문 첫 비주석 statement가 'use client' 인지 확인.
 */
function hasUseClientDirective(content) {
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use client['"]\s*;?/.test(content);
}

/**
 * App Router 특수 파일(page/layout/template/loading/not-found/default)인지 확인.
 * error.tsx 는 의무 Client Component 이므로 제외.
 */
function isAppRouterServerSpecialFile(relPath) {
  const norm = String(relPath).replace(/\\/g, '/');
  return /(?:^|\/)(?:src\/)?app\/(?:.+\/)?(?:page|layout|template|loading|not-found|default)\.tsx?$/.test(norm);
}

/**
 * metadata / generateMetadata export 가 있는 파일인지 확인.
 */
function hasMetadataExport(content) {
  if (/\bexport\s+(?:const|let|var|function|async\s+function)\s+(?:metadata|generateMetadata)\b/.test(content)) {
    return true;
  }
  return /\bexport\s*\{[^}]*\b(?:metadata|generateMetadata)\b[^}]*\}/.test(content);
}

/**
 * 파일이 (a) 'use client' 가 없고 (b) Server Component 표지를 가졌는지 판정.
 * 이런 파일에서는 dynamic(..., { ssr: false }) 가 빌드 에러를 일으킴.
 */
function isServerComponentFile(relPath, content) {
  if (hasUseClientDirective(content)) return false;
  if (hasMetadataExport(content)) return true;
  if (isAppRouterServerSpecialFile(relPath)) return true;
  return false;
}

// ---- AST helpers -----------------------------------------------------------

/**
 * `if (typeof <browserGlobal> !== 'undefined') { <varName> = <expr>; ... }` 패턴인지 검사.
 * else 절 없음 + 본문이 자기 자신에 대한 단순 할당만 가질 때 true.
 */
function isBrowserGuardForVariable(ifStatement, varName) {
  if (!ifStatement || ifStatement.getKind() !== SyntaxKind.IfStatement) return false;

  const condition = ifStatement.getExpression();
  if (!condition || condition.getKind() !== SyntaxKind.BinaryExpression) return false;

  const left = condition.getLeft();
  const right = condition.getRight();
  const op = condition.getOperatorToken();

  const isNotEquals =
    op.getKind() === SyntaxKind.ExclamationEqualsEqualsToken ||
    op.getKind() === SyntaxKind.ExclamationEqualsToken;
  if (!isNotEquals) return false;

  if (left.getKind() !== SyntaxKind.TypeOfExpression) return false;
  const typeofTarget = left.getExpression?.()?.getText?.() || '';
  if (!BROWSER_GLOBAL_NAMES.has(typeofTarget)) return false;

  const rightText = right.getText().replace(/^['"]|['"]$/g, '');
  if (rightText !== 'undefined') return false;

  if (ifStatement.getElseStatement()) return false;

  const thenBlock = ifStatement.getThenStatement();
  let statements = [];
  if (thenBlock.getKind() === SyntaxKind.Block) {
    statements = thenBlock.getStatements();
  } else {
    statements = [thenBlock];
  }
  if (statements.length === 0) return false;

  for (const stmt of statements) {
    if (stmt.getKind() !== SyntaxKind.ExpressionStatement) return false;
    const expr = stmt.getExpression();
    if (expr.getKind() !== SyntaxKind.BinaryExpression) return false;
    const innerOp = expr.getOperatorToken();
    if (innerOp.getKind() !== SyntaxKind.EqualsToken) return false;
    if (expr.getLeft().getText() !== varName) return false;
  }

  return true;
}

/**
 * 식별자가 SourceFile 안에서 "값으로 읽히는" 곳이 있는지 판정합니다.
 * 자기 선언과 (선택적으로) 자기 할당 좌변 1곳은 사용으로 치지 않습니다.
 *
 * @param {import('ts-morph').SourceFile} sourceFile
 * @param {import('ts-morph').VariableDeclaration} varDeclarationNode
 * @param {string} varName
 */
function isIdentifierReadAnywhere(sourceFile, varDeclarationNode, varName) {
  const refs = sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((id) => id.getText() === varName);

  for (const id of refs) {
    const decl = id.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (decl && decl === varDeclarationNode) continue;

    // 자기 자신에 대한 = 할당의 좌변은 "쓰기" 이므로 사용으로 치지 않음.
    const binary = id.getFirstAncestorByKind(SyntaxKind.BinaryExpression);
    if (binary) {
      const op = binary.getOperatorToken();
      if (
        op.getKind() === SyntaxKind.EqualsToken &&
        binary.getLeft().getText() === varName
      ) {
        continue;
      }
    }
    return true;
  }
  return false;
}

/**
 * 파일 내에서 식별자가 "값으로 읽히는지" 판정.
 * - 자기 자신의 선언자
 * - 가드 if 블록 내부의 자기 할당 좌변
 * 위 두 가지는 사용으로 치지 않음.
 */
function isIdentifierUsed(sourceFile, varDeclarationNode, ifStatementNode, varName) {
  const refs = sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((id) => id.getText() === varName);

  for (const id of refs) {
    const decl = id.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (decl && decl === varDeclarationNode) continue;

    if (
      ifStatementNode &&
      ifStatementNode.getStart() <= id.getStart() &&
      id.getEnd() <= ifStatementNode.getEnd()
    ) {
      const binary = id.getFirstAncestorByKind(SyntaxKind.BinaryExpression);
      if (binary) {
        const op = binary.getOperatorToken();
        const isAssign =
          op.getKind() === SyntaxKind.EqualsToken ||
          op.getKind() === SyntaxKind.PlusEqualsToken ||
          op.getKind() === SyntaxKind.MinusEqualsToken;
        const lhs = binary.getLeft();
        if (isAssign && lhs && lhs.getText() === varName) {
          continue;
        }
      }
    }

    return true;
  }
  return false;
}

// ---- Server Component 의 dynamic(ssr:false) 무력화 ------------------------

/**
 * Server Component 파일에서 `dynamic(<loader>, { ssr: false })` 패턴의 `ssr: false` 만
 * 결정론적으로 제거. 옵션 객체가 비면 두 번째 인자 자체도 함께 제거.
 *
 * 이유:
 *   - Next.js App Router 는 Server Component 에서 `ssr: false` 를 허용하지 않음
 *     (Turbopack 빌드 시 "ssr: false is not allowed with next/dynamic in Server Components" 에러).
 *   - dynamic() 자체는 Server Component 에서도 합법(코드 스플리팅 용도).
 *
 * @returns {{ changed: boolean, fixedTargets: string[] }}
 */
function stripSsrFalseInServerComponent(sourceFile, relPath) {
  const fullText = sourceFile.getFullText();
  const fixedTargets = [];

  // 빠른 거름망: 'ssr' 단어가 없으면 처리할 게 없음
  if (!fullText.includes('ssr')) return { changed: false, fixedTargets };
  if (!isServerComponentFile(relPath, fullText)) return { changed: false, fixedTargets };

  let modified = false;
  const callExprs = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExprs) {
    const calleeText = call.getExpression().getText();
    // dynamic(...) 또는 someAlias.dynamic(...) 가 아닌 단순 dynamic 호출만 대상
    if (calleeText !== 'dynamic') continue;

    const args = call.getArguments();
    if (args.length < 2) continue;

    const optionsArg = args[1];
    if (optionsArg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;

    // ssr: false 프로퍼티 찾아 제거
    const props = optionsArg.getProperties();
    let removedSsr = false;
    for (const prop of props) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const nameNode = prop.getNameNode?.();
      if (!nameNode || nameNode.getText() !== 'ssr') continue;
      const initializer = prop.getInitializer?.();
      if (initializer && initializer.getText() === 'false') {
        prop.remove();
        removedSsr = true;
        modified = true;
      }
    }

    if (!removedSsr) continue;

    // 컴포넌트 식별자(있다면) 추적용
    const parentVarDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const compName = parentVarDecl ? parentVarDecl.getName() : '<inline>';
    fixedTargets.push(`${relPath}:${compName}`);

    // 옵션 객체가 비면 두 번째 인자 자체 제거
    const remainingProps = optionsArg.getProperties();
    if (remainingProps.length === 0) {
      try {
        // ts-morph는 인덱스 기반 removeArgument 를 제공
        call.removeArgument(1);
      } catch {
        // 실패해도 ssr: false 는 이미 제거된 상태이므로 빌드는 안전
      }
    }
  }

  return { changed: modified, fixedTargets };
}

// ---- 메인 sweep -----------------------------------------------------------

/**
 * 단일 파일에 대해 결정론적 sweep 수행.
 * @returns {Promise<{ changed: boolean, removedTargets: string[] }>}
 */
async function sweepSingleFile(projectRoot, relPath) {
  const absPath = path.join(projectRoot, relPath);
  if (!fs.existsSync(absPath)) {
    return { changed: false, removedTargets: [] };
  }
  if (!SUPPORTED_EXT.test(relPath)) {
    return { changed: false, removedTargets: [] };
  }

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  let sourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(absPath);
  } catch {
    return { changed: false, removedTargets: [] };
  }

  let modified = false;
  const removedTargets = [];

  // 1) 모듈-스코프 dead `let X = INIT; if (typeof <browser> ...) { X = ... }` 제거
  const topLevelVarStmts = sourceFile
    .getStatements()
    .filter((s) => s.getKind() === SyntaxKind.VariableStatement);

  for (const varStmt of topLevelVarStmts) {
    const declarations = varStmt.getDeclarationList().getDeclarations();
    if (declarations.length !== 1) continue; // 단일 선언만 안전하게 처리
    const decl = declarations[0];
    const varName = decl.getName();
    if (!varName) continue;

    const nextSibling = varStmt.getNextSibling?.();
    if (!nextSibling) continue;
    if (!isBrowserGuardForVariable(nextSibling, varName)) continue;

    if (isIdentifierUsed(sourceFile, decl, nextSibling, varName)) continue;

    // dead 패턴 확정 — if 블록(뒤쪽)을 먼저 제거 후 var 선언 제거.
    nextSibling.remove();
    varStmt.remove();
    removedTargets.push(`${relPath}:${varName}`);
    modified = true;
  }

  // 1-B') 모듈-스코프 dead expression statement: 깨진 SSR-guard 시도 패턴
  //   `void typeof X !== 'undefined' ? <browser-access> : <fallback>;`
  //
  //   연산자 우선순위 때문에 `(void typeof X) !== 'undefined'` 로 해석되고,
  //   `void typeof X` 는 언제나 `undefined`, `undefined !== 'undefined'` 는 항상 `true` 라
  //   then 절(브라우저 API 접근)이 항상 실행됩니다. 결과:
  //     - SSR/build 시 `ReferenceError: window is not defined` 로 빌드 차단
  //     - module-scope 라 page data collection 단계에서 즉시 폭발
  //   이건 Gemini 가 SSR-guard 를 추가하려다 실패한 dead 패턴이므로 통째로 제거.
  {
    const topLevelExprStmts = sourceFile
      .getStatements()
      .filter((s) => s.getKind() === SyntaxKind.ExpressionStatement);
    for (let i = topLevelExprStmts.length - 1; i >= 0; i--) {
      const stmt = topLevelExprStmts[i];
      const expr = stmt.getExpression();
      if (!expr) continue;

      // 두 가지 형태 지원:
      //   (a) statement 자체가 ConditionalExpression — `void typeof X !== 'u' ? a : b;`
      //   (b) statement 자체가 BinaryExpression(`void typeof X !== 'u'`)  ← 일부 AI 출력
      let condition = null;
      if (expr.getKind() === SyntaxKind.ConditionalExpression) {
        condition = expr.getCondition?.();
      } else if (expr.getKind() === SyntaxKind.BinaryExpression) {
        condition = expr;
      }
      if (!condition || condition.getKind() !== SyntaxKind.BinaryExpression) continue;

      const opToken = condition.getOperatorToken?.();
      const opKind = opToken ? opToken.getKind() : null;
      if (
        opKind !== SyntaxKind.ExclamationEqualsEqualsToken &&
        opKind !== SyntaxKind.EqualsEqualsEqualsToken &&
        opKind !== SyntaxKind.ExclamationEqualsToken &&
        opKind !== SyntaxKind.EqualsEqualsToken
      ) continue;

      const left = condition.getLeft?.();
      const right = condition.getRight?.();
      if (!left || !right) continue;

      const isVoidTypeof = (node) => {
        if (!node || node.getKind() !== SyntaxKind.VoidExpression) return false;
        const inner = node.getExpression?.();
        if (!inner || inner.getKind() !== SyntaxKind.TypeOfExpression) return false;
        const innerExpr = inner.getExpression?.();
        if (!innerExpr || innerExpr.getKind() !== SyntaxKind.Identifier) return false;
        return BROWSER_GLOBAL_NAMES.has(innerExpr.getText());
      };
      const isUndefinedString = (node) => {
        if (!node) return false;
        if (node.getKind() === SyntaxKind.StringLiteral) {
          return node.getLiteralText?.() === 'undefined';
        }
        return false;
      };

      const matches =
        (isVoidTypeof(left) && isUndefinedString(right)) ||
        (isVoidTypeof(right) && isUndefinedString(left));
      if (!matches) continue;

      try {
        stmt.remove();
        removedTargets.push(`${relPath}:dead-broken-ssr-guard`);
        modified = true;
      } catch {
        // 무시
      }
    }
  }

  // 1-B) 모듈-스코프 dead expression statement: `void <expr> ? <a> : <b>;`
  //   - `void <anything>` 는 항상 `undefined`(falsy) → 항상 `:` 분기 → 결과 미사용
  //   - TypeScript 가 TS2873 "This kind of expression is always falsy." 로 빌드 실패시킴
  //   - server 측 prerender 단계에서 평가되어 useState null 같은 간접 에러도 야기
  //   - step5 의 Gemini 가 자주 만드는 패턴이므로 결정론적으로 제거
  {
    const topLevelExprStmts = sourceFile
      .getStatements()
      .filter((s) => s.getKind() === SyntaxKind.ExpressionStatement);
    // 뒤에서부터 제거해야 인덱스가 흐트러지지 않음
    for (let i = topLevelExprStmts.length - 1; i >= 0; i--) {
      const stmt = topLevelExprStmts[i];
      const expr = stmt.getExpression();
      if (!expr || expr.getKind() !== SyntaxKind.ConditionalExpression) continue;
      const condition = expr.getCondition?.();
      if (!condition) continue;
      // 조건 자체가 `void <anything>` 인 경우만 제거 (항상 falsy 보장)
      if (condition.getKind() !== SyntaxKind.VoidExpression) continue;
      try {
        stmt.remove();
        removedTargets.push(`${relPath}:dead-void-conditional`);
        modified = true;
      } catch {
        // 안전망 자체가 마이그레이션을 막지 않도록 무시
      }
    }
  }

  // 1-C) 모듈-스코프 미사용 const/let `const _<name> = <expr>;`
  //   - step5 Gemini 가 dead variable 을 `_` 접두로 의도 표시하지만,
  //     tsc 의 "noUnusedLocals" 가 켜져 있으면 TS6133 으로 빌드를 실패시킴
  //   - 어디서도 안 읽히면 결정론적으로 제거 (이름이 _ 로 시작하는 것만 — 의도가 명확한 표지)
  {
    const topLevelVarStmts2 = sourceFile
      .getStatements()
      .filter((s) => s.getKind() === SyntaxKind.VariableStatement);
    for (let i = topLevelVarStmts2.length - 1; i >= 0; i--) {
      const varStmt = topLevelVarStmts2[i];
      const declarations = varStmt.getDeclarationList().getDeclarations();
      if (declarations.length !== 1) continue;
      const decl = declarations[0];
      const varName = decl.getName();
      if (!varName || !/^_/.test(varName)) continue;
      // export 된 식별자는 보존
      if (varStmt.getModifiers?.().some((m) => m.getKind() === SyntaxKind.ExportKeyword)) continue;
      if (isIdentifierReadAnywhere(sourceFile, decl, varName)) continue;
      try {
        varStmt.remove();
        removedTargets.push(`${relPath}:unused-underscore-var:${varName}`);
        modified = true;
      } catch {
        // 무시
      }
    }
  }

  // 1-E) 결정론적 unused import 제거 (TS6133 박멸).
  //   - default-only:  `import X from 'foo'` 가 어디서도 사용 안 되면 전체 declaration 제거.
  //   - named-only:    `import { X, Y } from 'foo'` 에서 사용 안 되는 named 만 제거.
  //                    모두 사용 안 되면 declaration 제거.
  //   - namespace:     `import * as ns from 'foo'` 가 사용 안 되면 declaration 제거.
  //   - mixed (`import X, { Y } from 'foo'`) 와 type-only (`import type { X }`) 는 보수적으로 보존.
  //   - side-effect import (`import 'foo'`) 는 절대 손대지 않음.
  {
    const importDecls = sourceFile.getImportDeclarations();
    for (let i = importDecls.length - 1; i >= 0; i--) {
      const imp = importDecls[i];
      if (imp.isTypeOnly && imp.isTypeOnly()) continue; // type-only 는 보수적으로 보존

      const def = imp.getDefaultImport();
      const named = imp.getNamedImports();
      const ns = imp.getNamespaceImport();

      // side-effect import: import 'foo' — 보존
      if (!def && named.length === 0 && !ns) continue;

      // mixed (default + named) 는 ts-morph remove 처리가 까다로워서 보수적으로 보존
      if (def && (named.length > 0 || ns)) continue;

      const isIdentReadElsewhere = (name) => {
        const refs = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
        for (const id of refs) {
          if (id.getText() !== name) continue;
          // import 선언 안에 있는 동일 이름은 사용으로 치지 않음
          const insideImport = id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
          if (insideImport && insideImport === imp) continue;
          return true;
        }
        return false;
      };

      // default-only
      if (def && named.length === 0 && !ns) {
        const name = def.getText();
        if (!isIdentReadElsewhere(name)) {
          try {
            imp.remove();
            removedTargets.push(`${relPath}:unused-import:${name}`);
            modified = true;
          } catch {
            // 무시
          }
        }
        continue;
      }

      // namespace-only
      if (ns && !def && named.length === 0) {
        const name = ns.getName();
        if (!isIdentReadElsewhere(name)) {
          try {
            imp.remove();
            removedTargets.push(`${relPath}:unused-import:* as ${name}`);
            modified = true;
          } catch {
            // 무시
          }
        }
        continue;
      }

      // named-only
      if (named.length > 0 && !def && !ns) {
        const unusedNamed = named.filter((n) => {
          const aliasNode = n.getAliasNode?.();
          const localName = aliasNode ? aliasNode.getText() : n.getName();
          return !isIdentReadElsewhere(localName);
        });
        if (unusedNamed.length === 0) continue;
        if (unusedNamed.length === named.length) {
          try {
            imp.remove();
            for (const n of unusedNamed) {
              removedTargets.push(`${relPath}:unused-import:${n.getName()}`);
            }
            modified = true;
          } catch {
            // 무시
          }
        } else {
          for (const n of unusedNamed) {
            try {
              n.remove();
              removedTargets.push(`${relPath}:unused-named-import:${n.getName()}`);
              modified = true;
            } catch {
              // 무시
            }
          }
        }
      }
    }
  }

  // 1-F) JSX attribute 이름 정규화: `fetchpriority` → `fetchPriority` (React TS2322 박멸)
  //   - HTML 명세상 lowercase `fetchpriority` 가 표준이지만 React는 camelCase prop 만 인식.
  //   - 타입 정의가 없는 prop 으로 취급되어 `Type '... fetchpriority: string ...' is not
  //     assignable to type 'DetailedHTMLProps<LinkHTMLAttributes<...>>'` 빌드 에러 유발.
  //   - 결정론적 변경: JSX attribute 이름 노드만 교체. 문자열·주석 안에는 손대지 않음.
  {
    const jsxAttrs = sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute);
    for (const attr of jsxAttrs) {
      const nameNode = attr.getNameNode?.();
      if (!nameNode) continue;
      if (nameNode.getText() === 'fetchpriority') {
        try {
          nameNode.replaceWithText('fetchPriority');
          removedTargets.push(`${relPath}:jsx-prop-rename:fetchpriority->fetchPriority`);
          modified = true;
        } catch {
          // 무시
        }
      }
    }
  }

  // 1-D) 위 정리 결과로 `const isWindowDefined = typeof <browser> !== 'undefined';` 같은
  //   "browser presence flag" 가 어디서도 안 읽히게 됐다면 함께 제거.
  //   - 식별자만 보고 판단하지 않고, 초기화식이 `typeof <BROWSER_GLOBAL> !== 'undefined'`
  //     인 모듈-스코프 const/let 만 대상으로 함 (안전한 좁은 패턴)
  {
    const topLevelVarStmts3 = sourceFile
      .getStatements()
      .filter((s) => s.getKind() === SyntaxKind.VariableStatement);
    for (let i = topLevelVarStmts3.length - 1; i >= 0; i--) {
      const varStmt = topLevelVarStmts3[i];
      const declarations = varStmt.getDeclarationList().getDeclarations();
      if (declarations.length !== 1) continue;
      const decl = declarations[0];
      const varName = decl.getName();
      if (!varName) continue;
      const init = decl.getInitializer?.();
      if (!init || init.getKind() !== SyntaxKind.BinaryExpression) continue;

      const op = init.getOperatorToken();
      const isNotEquals =
        op.getKind() === SyntaxKind.ExclamationEqualsEqualsToken ||
        op.getKind() === SyntaxKind.ExclamationEqualsToken;
      if (!isNotEquals) continue;

      const left = init.getLeft();
      const right = init.getRight();
      if (left.getKind() !== SyntaxKind.TypeOfExpression) continue;
      const typeofTarget = left.getExpression?.()?.getText?.() || '';
      if (!BROWSER_GLOBAL_NAMES.has(typeofTarget)) continue;
      const rightText = right.getText().replace(/^['"]|['"]$/g, '');
      if (rightText !== 'undefined') continue;

      // export 된 flag 는 보존
      if (varStmt.getModifiers?.().some((m) => m.getKind() === SyntaxKind.ExportKeyword)) continue;
      if (isIdentifierReadAnywhere(sourceFile, decl, varName)) continue;

      try {
        varStmt.remove();
        removedTargets.push(`${relPath}:unused-browser-flag:${varName}`);
        modified = true;
      } catch {
        // 무시
      }
    }
  }

  // 2) AI 자기-설명 메타 주석 제거
  let fullText = sourceFile.getFullText();
  let cleaned = fullText;
  for (const re of AI_META_COMMENT_PATTERNS) {
    cleaned = cleaned.replace(re, '');
  }
  if (cleaned !== fullText) {
    sourceFile.replaceWithText(cleaned);
    modified = true;
  }

  // 3) Server Component 에 박힌 dynamic(..., { ssr: false }) 의 ssr: false 만 제거
  //    - Turbopack/Next.js App Router 빌드 에러 사전 차단
  //    - dynamic() 자체는 보존 (코드 스플리팅 의도 유지)
  try {
    const { changed: ssrChanged, fixedTargets } = stripSsrFalseInServerComponent(sourceFile, relPath);
    if (ssrChanged) {
      modified = true;
      for (const t of fixedTargets) {
        removedTargets.push(`ssr:false@${t}`);
      }
    }
  } catch {
    // 안전망 자체가 마이그레이션을 막지 않도록 조용히 무시
  }

  if (modified) {
    await sourceFile.save();
  }

  return { changed: modified, removedTargets };
}

/**
 * 여러 파일에 대해 결정론적 sweep 수행. Gemini가 작성한 파일 목록을 받아 후처리.
 * - LLM 호출 없음 (토큰 비용 0)
 * - 후보당 수십 ms 수준 (디스크 I/O + ts-morph 파싱)
 * @param {string} projectRoot
 * @param {string[]} relPaths Gemini가 적용한(또는 적용 후보) 파일 상대 경로
 * @returns {Promise<{ changedFiles: string[], removedTargets: string[] }>}
 */
async function sweepAfterAiApply(projectRoot, relPaths) {
  const changedFiles = [];
  const removedTargets = [];
  const seen = new Set();

  for (const rel of Array.isArray(relPaths) ? relPaths : []) {
    const norm = String(rel || '').replace(/\\/g, '/');
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);

    try {
      const { changed, removedTargets: targets } = await sweepSingleFile(projectRoot, norm);
      if (changed) {
        changedFiles.push(norm);
      }
      if (targets.length > 0) {
        removedTargets.push(...targets);
      }
    } catch {
      // 안전망 자체가 마이그레이션을 막지 않도록 개별 파일 오류는 조용히 무시
    }
  }

  return { changedFiles, removedTargets };
}

module.exports = {
  sweepAfterAiApply,
  sweepSingleFile,
  // 테스트 편의를 위해 내부 함수도 export
  isBrowserGuardForVariable,
  isIdentifierUsed,
};
