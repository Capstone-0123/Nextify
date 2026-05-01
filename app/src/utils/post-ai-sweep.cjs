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
