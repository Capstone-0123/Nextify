'use strict';

// app/src/utils/strip-react-router-leak.cjs
// 결정론적(LLM 호출 없음) 후처리: src/app/providers.tsx 같은 파일에 잘못 흘러든
// react-router-dom 코드(createBrowserRouter / RouterProvider 등)를 제거한다.
//
// Step 2 provider-generator 의 ROUTER_COMPONENTS 가 RouterProvider 를 누락하던 시절
// 이미 마이그레이션된 프로젝트의 providers.tsx 가 다음 패턴으로 깨져 있는 경우를
// 정리하기 위한 안전망:
//
//   import Main from '../pages/Main/Main';
//   ...
//   const router = createBrowserRouter([...]);
//   export function Providers({ children }) {
//     return <>{children}<RouterProvider router={router} /></>;
//   }
//
// 처리:
//  1) `const x = createBrowserRouter|createHashRouter|createMemoryRouter(...)` 변수 선언 제거
//  2) <RouterProvider .../> 자기-닫는 JSX 제거
//  3) <BrowserRouter>/<HashRouter>/<MemoryRouter>/<Routes>/<Route> 같은 react-router
//     컨테이너 JSX 는 children 만 남기고 래퍼 제거
//  4) 사용처가 사라진 react-router-dom / 상대 page 컴포넌트 import 는 후속 typecheck
//     autofix(TS6192) 가 정리하므로 여기서는 손대지 않는다 (오탐 방지)

const fs = require('fs-extra');
const path = require('path');
const { Project, SyntaxKind } = require('ts-morph');

const ROUTER_FACTORY_NAMES = new Set([
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
  'createRouter',
]);

const ROUTER_JSX_WRAPPERS = new Set([
  'BrowserRouter',
  'HashRouter',
  'MemoryRouter',
  'StaticRouter',
  'NativeRouter',
  'Routes',
  'Switch',
]);

const ROUTER_SELFCLOSING = new Set([
  'RouterProvider',
  'Route', // 단독으로 남으면 무용지물
  'Outlet',
]);

function isRouterFactoryCall(node) {
  if (!node) return false;
  if (node.getKind() !== SyntaxKind.CallExpression) return false;
  const expr = node.getExpression();
  if (expr.getKind() !== SyntaxKind.Identifier) return false;
  return ROUTER_FACTORY_NAMES.has(expr.getText());
}

/**
 * 단일 파일에서 react-router 누수를 제거.
 * @returns {Promise<{ changed: boolean, removals: string[] }>}
 */
async function stripRouterLeakInFile(absPath) {
  if (!(await fs.pathExists(absPath))) {
    return { changed: false, removals: [] };
  }

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  let sourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(absPath);
  } catch {
    return { changed: false, removals: [] };
  }

  const removals = [];

  // 1) router factory 변수 선언 제거
  for (const stmt of sourceFile.getVariableStatements()) {
    const declList = stmt.getDeclarationList();
    const decls = declList.getDeclarations();
    if (decls.length === 0) continue;

    const allRouterFactory = decls.every((d) => {
      const init = d.getInitializer();
      return isRouterFactoryCall(init);
    });

    if (allRouterFactory) {
      removals.push(
        `var:${decls.map((d) => d.getName()).join(',')}=${decls
          .map((d) => d.getInitializer()?.getExpression?.()?.getText())
          .join(',')}`,
      );
      stmt.remove();
    }
  }

  // 2) <RouterProvider .../> 자기-닫는 JSX 제거
  // descendants 가 변할 수 있으므로 한 번 수집 후 살아있는 노드만 처리
  const selfClosingTargets = sourceFile
    .getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
    .filter((el) => {
      try {
        const tag = el.getTagNameNode().getText();
        return ROUTER_SELFCLOSING.has(tag);
      } catch {
        return false;
      }
    });

  for (const el of selfClosingTargets) {
    if (el.wasForgotten?.()) continue;
    try {
      const tag = el.getTagNameNode().getText();
      const parent = el.getParent();
      if (!parent) continue;

      // {expression} 컨테이너 안에 있으면 expression 자체를 비운다
      if (parent.getKind() === SyntaxKind.JsxExpression) {
        try {
          parent.replaceWithText('');
          removals.push(`jsx-self:${tag}`);
          continue;
        } catch {
          // fallthrough
        }
      }

      // 부모가 JSX (element/fragment/...) 면 자기 자신만 제거
      el.replaceWithText('');
      removals.push(`jsx-self:${tag}`);
    } catch {
      // ignore
    }
  }

  // 3) <BrowserRouter>...children...</BrowserRouter> 같은 컨테이너는 children 만 남김
  const wrapperTargets = sourceFile
    .getDescendantsOfKind(SyntaxKind.JsxElement)
    .filter((el) => {
      try {
        const open = el.getOpeningElement();
        return ROUTER_JSX_WRAPPERS.has(open.getTagNameNode().getText());
      } catch {
        return false;
      }
    });

  for (const el of wrapperTargets) {
    if (el.wasForgotten?.()) continue;
    try {
      const tag = el.getOpeningElement().getTagNameNode().getText();
      const childrenText = el
        .getJsxChildren()
        .map((c) => c.getText())
        .join('');
      el.replaceWithText(childrenText);
      removals.push(`jsx-wrap:${tag}`);
    } catch {
      // ignore
    }
  }

  if (removals.length === 0) {
    return { changed: false, removals };
  }

  try {
    await sourceFile.save();
  } catch {
    return { changed: false, removals };
  }

  return { changed: true, removals };
}

/**
 * 프로젝트의 src/app/providers.tsx (있으면) 에서 router 누수 제거.
 */
async function stripRouterLeakInProviders(projectRoot) {
  const candidates = [
    path.join(projectRoot, 'src', 'app', 'providers.tsx'),
    path.join(projectRoot, 'app', 'providers.tsx'),
  ];

  const results = [];
  for (const abs of candidates) {
    if (!(await fs.pathExists(abs))) continue;
    const r = await stripRouterLeakInFile(abs);
    if (r.changed) results.push({ file: abs, removals: r.removals });
  }
  return results;
}

module.exports = {
  stripRouterLeakInFile,
  stripRouterLeakInProviders,
};
