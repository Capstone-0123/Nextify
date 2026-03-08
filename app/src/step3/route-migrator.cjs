// src/step3/route-migrator.cjs
// Route 마이그레이션 모듈 (React Router → Next.js App Router)

const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');

// ============================================================================
// 상수 정의
// ============================================================================

/**
 * 동적 세그먼트 변환 매핑 (:id → [id])
 */
function convertDynamicSegment(segment) {
  if (segment.startsWith(':')) {
    return `[${segment.slice(1)}]`;
  }
  return segment;
}

/**
 * 경로를 Next.js 폴더 구조로 변환
 * 예: /users/:id → users/[id]
 */
function pathToFolderStructure(routePath) {
  if (!routePath || routePath === '/') {
    return [];
  }

  const segments = routePath
    .split('/')
    .filter(s => s && s !== '/')
    .map(convertDynamicSegment);

  return segments;
}

// ============================================================================
// Route 태그 파싱 및 추출
// ============================================================================

/**
 * Route 태그에서 정보 추출
 */
function extractRouteInfo(routeNode, routeElement = null) {
  const pathAttr = routeNode.getAttribute('path');
  const indexAttr = routeNode.getAttribute('index');
  const elementAttr = routeNode.getAttribute('element');

  const pathValue = pathAttr
    ? pathAttr.getInitializer()?.getText().replace(/['"]/g, '')
    : null;
  const isIndex = !!indexAttr;
  // element 속성의 JSX AST 노드 추출
  let elementJsxNode = null;
  if (elementAttr) {
    const initializer = elementAttr.getInitializer();
    if (initializer) {
      // JsxExpression인 경우 (element={<Component />})
      if (initializer.getKind() === SyntaxKind.JsxExpression) {
        const expression = initializer.getExpression();
        if (expression) {
          // JSX Element 또는 Fragment인 경우
          if (expression.getKind() === SyntaxKind.JsxElement ||
              expression.getKind() === SyntaxKind.JsxSelfClosingElement ||
              expression.getKind() === SyntaxKind.JsxFragment) {
            elementJsxNode = expression;
          }
        }
      }
    }
  }

  // element에서 컴포넌트 이름 추출 (하위 호환성)
  const elementValue = elementJsxNode ? elementJsxNode.getText() : (elementAttr ? elementAttr.getInitializer()?.getText() : null);
  let componentName = null;
  if (elementValue) {
    const match = elementValue.match(/<(\w+)/);
    if (match) {
      componentName = match[1];
    }
  }

  // 자식 Route 확인 (중첩 라우트)
  // Route Element의 자식 노드에서 Route를 찾아야 함
  let hasChildren = false;
  let childRoutes = [];
  
  if (routeElement) {
    // Route Element의 모든 하위 노드를 재귀적으로 탐색하여 Route 찾기
    function findChildRoutes(node, depth = 0) {
      if (!node) return;
      
      const kind = node.getKind();
      
      // JsxSelfClosingElement인 경우 (<Route />)
      if (kind === SyntaxKind.JsxSelfClosingElement) {
        const tagName = node.getTagNameNode().getText();
        if (tagName === 'Route') {
          hasChildren = true;
          const childInfo = extractRouteInfo(node);
          childRoutes.push({
            node: node,
            element: null,
            ...childInfo,
          });
          return; // Route를 찾았으므로 더 깊이 들어가지 않음
        }
      }
      // JsxElement인 경우 (<Route>...</Route>)
      else if (kind === SyntaxKind.JsxElement) {
        const opening = node.getOpeningElement();
        const tagName = opening ? opening.getTagNameNode().getText() : '';
        
        if (tagName === 'Route') {
          hasChildren = true;
          const childInfo = extractRouteInfo(opening, node);
          childRoutes.push({
            node: opening,
            element: node,
            ...childInfo,
          });
          return; // Route를 찾았으므로 더 깊이 들어가지 않음
        }
        
        // Route가 아니면 자식 탐색
        const children = node.getJsxChildren();
        for (const child of children) {
          findChildRoutes(child, depth + 1);
        }
      }
      // JsxFragment인 경우
      else if (kind === SyntaxKind.JsxFragment) {
        const children = node.getJsxChildren();
        for (const child of children) {
          findChildRoutes(child, depth + 1);
        }
      }
      // ParenthesizedExpression인 경우 (조건부 렌더링 등)
      else if (kind === SyntaxKind.ParenthesizedExpression) {
        const expression = node.getExpression();
        if (expression) {
          findChildRoutes(expression, depth + 1);
        }
      }
      // JsxText는 무시 (공백, 줄바꿈 등)
      else if (kind === SyntaxKind.JsxText) {
        // 공백만 있는 경우 무시
        const text = node.getText();
        if (text.trim()) {
          // 공백이 아닌 텍스트가 있으면 로그 (디버깅용)
          // console.log(`      텍스트 노드: "${text.trim()}"`);
        }
      }
      // 다른 노드 타입은 무시
    }
    
    // Route Element의 직접 자식부터 탐색 시작
    const directChildren = routeElement.getJsxChildren();
    for (let i = 0; i < directChildren.length; i++) {
      const child = directChildren[i];
      findChildRoutes(child, 1);
    }
  }

  return {
    path: pathValue,
    isIndex,
    componentName,
    elementValue,
    elementJsxNode, // ✅ 추가: JSX AST 노드 전체
    hasChildren,
    childRoutes,
  };
}

/**
 * 소스 파일에서 최상위 Route 태그만 찾기 (자식 Route는 제외)
 */
function findAllRoutes(sourceFile) {
  const routes = [];
  const childRouteNodes = new Set(); // 자식 Route 노드를 추적

  // 먼저 모든 Route를 찾고, 자식 Route를 식별
  const allRouteElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement);
  const allSelfClosingRoutes = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  
  // 1단계: 모든 Route를 찾고 자식 Route를 식별
  for (const element of allRouteElements) {
    const opening = element.getOpeningElement();
    if (opening && opening.getTagNameNode().getText() === 'Route') {
      const info = extractRouteInfo(opening, element);
      
      // 자식 Route 노드들을 추적
      if (info.childRoutes && info.childRoutes.length > 0) {
        for (const childRoute of info.childRoutes) {
          childRouteNodes.add(childRoute.node);
        }
      }
      
      routes.push({
        node: opening,
        element: element,
        ...info,
      });
    }
  }

  for (const element of allSelfClosingRoutes) {
    if (element.getTagNameNode().getText() === 'Route') {
      const info = extractRouteInfo(element);
      routes.push({
        node: element,
        element: null,
        ...info,
      });
    }
  }

  // 2단계: 부모 Route의 자식인 Route 노드들을 추적
  for (const route of routes) {
    if (route.node) {
      const parent = route.node.getParent();
      if (parent) {
        const grandParent = parent.getParent();
        if (grandParent && grandParent.getKind() === SyntaxKind.JsxElement) {
          const grandParentOpening = grandParent.getOpeningElement();
          if (grandParentOpening && grandParentOpening.getTagNameNode().getText() === 'Route') {
            childRouteNodes.add(route.node);
          }
        }
      }
    }
  }

  // 3단계: 자식 Route가 아닌 최상위 Route만 반환
  const topLevelRoutes = routes.filter(route => !childRouteNodes.has(route.node));
  return topLevelRoutes;
}

/**
 * useRoutes hook 호출 찾기
 */
function findUseRoutesCalls(sourceFile) {
  const calls = [];
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    const expression = call.getExpression();
    if (expression.getText() === 'useRoutes') {
      const args = call.getArguments();
      if (args.length > 0) {
        calls.push({
          node: call,
          arrayArg: args[0],
        });
      }
    }
  }

  return calls;
}

/**
 * 조건부 보호 라우트 감지 (삼항 연산자)
 */
function detectConditionalRoute(elementValue) {
  if (!elementValue) return null;

  // 삼항 연산자 패턴: condition ? <Component /> : <Navigate to="/login" />
  const ternaryMatch = elementValue.match(/(.+)\s*\?\s*(<[^>]+>)\s*:\s*(<[^>]+>)/);
  if (ternaryMatch) {
    const condition = ternaryMatch[1].trim();
    const trueBranch = ternaryMatch[2];
    const falseBranch = ternaryMatch[3];

    // Navigate 컴포넌트 찾기 및 to prop 추출
    let navigateBranch = null;
    let protectedBranch = null;
    let redirectPath = '/login'; // 기본값

    if (trueBranch.includes('Navigate')) {
      navigateBranch = trueBranch;
      protectedBranch = falseBranch;
      // Navigate의 to prop 추출
      const toMatch = navigateBranch.match(/to\s*=\s*["']([^"']+)["']/);
      if (toMatch) {
        redirectPath = toMatch[1];
      }
      return {
        isConditional: true,
        condition: `!(${condition})`,
        protectedComponent: protectedBranch.match(/<(\w+)/)?.[1] || 'Component',
        redirectPath,
      };
    } else if (falseBranch.includes('Navigate')) {
      navigateBranch = falseBranch;
      protectedBranch = trueBranch;
      // Navigate의 to prop 추출
      const toMatch = navigateBranch.match(/to\s*=\s*["']([^"']+)["']/);
      if (toMatch) {
        redirectPath = toMatch[1];
      }
      return {
        isConditional: true,
        condition,
        protectedComponent: protectedBranch.match(/<(\w+)/)?.[1] || 'Component',
        redirectPath,
      };
    }
  }

  return null;
}

// ============================================================================
// Import 경로 계산
// ============================================================================

/**
 * 컴포넌트의 import 경로 찾기
 */
function findComponentImportPath(sourceFile, componentName) {
  const imports = sourceFile.getImportDeclarations();

  for (const importDecl of imports) {
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport && defaultImport.getText() === componentName) {
      return importDecl.getModuleSpecifierValue();
    }

    const namedImports = importDecl.getNamedImports();
    for (const namedImport of namedImports) {
      const name = namedImport.getAliasNode()?.getText() || namedImport.getName();
      if (name === componentName) {
        return importDecl.getModuleSpecifierValue();
      }
    }
  }

  return null;
}

/**
 * 경로 재계산 (원본 파일 기준 → 새 파일 기준)
 */
function calculateNewImportPath(originalPath, sourceFilePath, targetFilePath) {
  if (!originalPath || !originalPath.startsWith('.')) {
    return originalPath;
  }

  const sourceDir = path.dirname(sourceFilePath);
  const absolutePath = path.resolve(sourceDir, originalPath);
  const targetDir = path.dirname(targetFilePath);
  let relativePath = path.relative(targetDir, absolutePath);

  relativePath = relativePath.split(path.sep).join('/');
  if (!relativePath.startsWith('.')) {
    relativePath = './' + relativePath;
  }

  return relativePath;
}

// ============================================================================
// JSX AST 처리 및 컴포넌트 식별자 수집
// ============================================================================

/**
 * JSX AST에서 모든 컴포넌트 식별자 수집 (명세 3.1.3)
 */
function collectComponentIdentifiers(jsxNode, sourceFile, identifiers = new Set()) {
  if (!jsxNode) return identifiers;

  const kind = jsxNode.getKind();

  if (kind === SyntaxKind.JsxElement) {
    const opening = jsxNode.getOpeningElement();
    const tagName = opening.getTagNameNode().getText();
    
    // 대문자로 시작하는 것은 컴포넌트로 간주
    if (tagName && tagName[0] === tagName[0].toUpperCase() && tagName[0] !== tagName[0].toLowerCase()) {
      identifiers.add(tagName);
    }

    // 자식 노드도 재귀적으로 탐색
    const children = jsxNode.getJsxChildren();
    for (const child of children) {
      collectComponentIdentifiers(child, sourceFile, identifiers);
    }
  } else if (kind === SyntaxKind.JsxSelfClosingElement) {
    const tagName = jsxNode.getTagNameNode().getText();
    if (tagName && tagName[0] === tagName[0].toUpperCase() && tagName[0] !== tagName[0].toLowerCase()) {
      identifiers.add(tagName);
    }
  } else if (kind === SyntaxKind.JsxFragment) {
    const children = jsxNode.getJsxChildren();
    for (const child of children) {
      collectComponentIdentifiers(child, sourceFile, identifiers);
    }
  } else if (kind === SyntaxKind.ParenthesizedExpression) {
    const expression = jsxNode.getExpression();
    if (expression) {
      collectComponentIdentifiers(expression, sourceFile, identifiers);
    }
  }

  return identifiers;
}

/**
 * JSX AST를 문자열로 변환 (Props 포함, 명세 3.1.1, 3.1.2)
 */
function jsxNodeToString(jsxNode) {
  if (!jsxNode) return '';
  return jsxNode.getText();
}

/**
 * JSX AST에서 Outlet을 children으로 치환 (명세 3.2.2)
 */
function replaceOutletWithChildren(jsxText) {
  if (!jsxText) return jsxText;
  
  // <Outlet /> 또는 <Outlet></Outlet> 패턴을 {children}으로 치환
  return jsxText
    .replace(/<Outlet\s*\/>/g, '{children}')
    .replace(/<Outlet>[\s\S]*?<\/Outlet>/g, '{children}');
}

/**
 * 컴포넌트의 import 정보 수집 (명세 3.1.4)
 */
function collectImportStatements(sourceFile, componentNames, targetFilePath) {
  const imports = new Map(); // modulePath -> { defaultImport, namedImports: Set }

  for (const componentName of componentNames) {
    const importDecl = sourceFile.getImportDeclaration(decl => {
      const defaultImport = decl.getDefaultImport();
      if (defaultImport && defaultImport.getText() === componentName) {
        return true;
      }
      const namedImports = decl.getNamedImports();
      return namedImports.some(n => {
        const name = n.getAliasNode()?.getText() || n.getName();
        return name === componentName;
      });
    });

    if (importDecl) {
      const modulePath = importDecl.getModuleSpecifierValue();
      const sourceFilePath = sourceFile.getFilePath();
      const newPath = calculateNewImportPath(modulePath, sourceFilePath, targetFilePath);

      if (!imports.has(newPath)) {
        imports.set(newPath, {
          defaultImport: null,
          namedImports: new Set(),
        });
      }

      const importInfo = imports.get(newPath);
      const defaultImport = importDecl.getDefaultImport();
      const namedImports = importDecl.getNamedImports();

      if (defaultImport && defaultImport.getText() === componentName) {
        importInfo.defaultImport = componentName;
      } else {
        const matchedNamed = namedImports.find(n => {
          const name = n.getAliasNode()?.getText() || n.getName();
          return name === componentName;
        });
        if (matchedNamed) {
          const name = matchedNamed.getAliasNode()?.getText() || matchedNamed.getName();
          importInfo.namedImports.add(name);
        }
      }
    }
  }

  // import 문 생성
  const importStatements = [];
  for (const [modulePath, info] of imports) {
    const parts = [];
    if (info.defaultImport) {
      parts.push(info.defaultImport);
    }
    if (info.namedImports.size > 0) {
      parts.push(`{ ${[...info.namedImports].join(', ')} }`);
    }
    if (parts.length > 0) {
      importStatements.push(`import ${parts.join(', ')} from '${modulePath}';`);
    }
  }

  return importStatements;
}

// ============================================================================
// page.tsx 생성
// ============================================================================

/**
 * page.tsx 파일 내용 생성 (명세 3.1.1, 3.1.2, 3.1.3, 3.1.4 준수)
 */
function generatePageContent(routeInfo, sourceFile, targetFilePath, isConditional = false, conditionalInfo = null) {
  // ✅ 수정: JSX AST 전체 재현 (명세 3.1.1)
  let jsxContent = '';
  if (routeInfo.elementJsxNode) {
    jsxContent = jsxNodeToString(routeInfo.elementJsxNode);
  } else if (routeInfo.elementValue) {
    // 하위 호환성: elementValue가 있으면 사용
    jsxContent = routeInfo.elementValue;
  } else {
    // fallback: 컴포넌트 이름만 사용
    jsxContent = `<${routeInfo.componentName} />`;
  }

  // ✅ 수정: 모든 컴포넌트 식별자 수집 (명세 3.1.3)
  const componentIdentifiers = new Set();
  if (routeInfo.elementJsxNode) {
    collectComponentIdentifiers(routeInfo.elementJsxNode, sourceFile, componentIdentifiers);
  } else {
    // 하위 호환성
    if (routeInfo.componentName) {
      componentIdentifiers.add(routeInfo.componentName);
    }
  }

  // ✅ 수정: import 문 생성 (명세 3.1.4)
  const importStatements = collectImportStatements(sourceFile, componentIdentifiers, targetFilePath);
  const importSection = importStatements.length > 0 ? importStatements.join('\n') + '\n\n' : '';

  let content = '';

  if (isConditional && conditionalInfo) {
    // 조건부 보호 라우트
    const redirectPath = conditionalInfo.redirectPath || '/login';
    content = `'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
${importSection}export default function Page() {
  const router = useRouter();
  const isAllowed = ${conditionalInfo.condition};

  useEffect(() => {
    if (!isAllowed) {
      router.replace('${redirectPath}');
    }
  }, [isAllowed, router]);

  if (!isAllowed) return null;
  return (
    ${jsxContent}
  );
}`;
  } else {
    // 일반 페이지 - ✅ 수정: JSX AST 전체 재현 (명세 3.1.1)
    content = `${importSection}export default function Page() {
  return (
    ${jsxContent}
  );
}`;
  }

  return content;
}

/**
 * layout.tsx 파일 내용 생성 (명세 3.2.1, 3.2.2, 3.2.3, 3.2.4 준수)
 * 중첩 라우트의 element에 전달된 JSX AST를 children을 감싸는 wrapper 컴포넌트로 재현
 */
function generateLayoutContent(routeInfo, sourceFile, targetFilePath) {
  let jsxContent = '';
  let componentIdentifiers = new Set();

  // JSX AST 재현 (명세 3.2.1)
  if (routeInfo.elementJsxNode) {
    const jsxNode = routeInfo.elementJsxNode;
    const kind = jsxNode.getKind();

    // 단일 JSXElement인 경우 (명세 3.2.1)
    if (kind === SyntaxKind.JsxElement) {
      const opening = jsxNode.getOpeningElement();
      const tagName = opening.getTagNameNode().getText();
      
      // 컴포넌트 식별자 수집
      componentIdentifiers.add(tagName);
      
      // 모든 속성(Props) 추출
      const attributes = opening.getAttributes();
      const propsString = attributes
        .map(attr => {
          if (attr.getKind() === SyntaxKind.JsxAttribute) {
            const name = attr.getNameNode().getText();
            const initializer = attr.getInitializer();
            if (initializer) {
              return `${name}=${initializer.getText()}`;
            }
            return name;
          } else if (attr.getKind() === SyntaxKind.JsxSpreadAttribute) {
            return `{...${attr.getExpression().getText()}}`;
          }
          return '';
        })
        .filter(Boolean)
        .join(' ');

      const propsSection = propsString ? ` ${propsString}` : '';
      
      // Outlet을 children으로 치환 (명세 3.2.2)
      // 자식 노드에서 Outlet 찾기
      const children = jsxNode.getJsxChildren();
      let hasOutlet = false;
      let childrenContent = '';

      for (const child of children) {
        const childKind = child.getKind();
        if (childKind === SyntaxKind.JsxSelfClosingElement) {
          const childTagName = child.getTagNameNode().getText();
          if (childTagName === 'Outlet') {
            hasOutlet = true;
            childrenContent += '{children}';
          } else {
            childrenContent += child.getText();
            // 컴포넌트 식별자 수집
            if (childTagName[0] === childTagName[0].toUpperCase()) {
              componentIdentifiers.add(childTagName);
            }
          }
        } else if (childKind === SyntaxKind.JsxElement) {
          const childOpening = child.getOpeningElement();
          const childTagName = childOpening.getTagNameNode().getText();
          if (childTagName === 'Outlet') {
            hasOutlet = true;
            childrenContent += '{children}';
          } else {
            childrenContent += child.getText();
            // 컴포넌트 식별자 수집
            if (childTagName[0] === childTagName[0].toUpperCase()) {
              componentIdentifiers.add(childTagName);
            }
          }
        } else if (childKind === SyntaxKind.JsxText) {
          const text = child.getText().trim();
          if (text) {
            childrenContent += child.getText();
          }
        } else {
          childrenContent += child.getText();
        }
      }

      // Outlet이 없으면 {children} 추가 (명세 3.2.3)
      if (!hasOutlet) {
        childrenContent += '{children}';
      }

      jsxContent = `<${tagName}${propsSection}>${childrenContent}</${tagName}>`;
    } else if (kind === SyntaxKind.JsxSelfClosingElement) {
      // Self-closing element인 경우 (드물지만 처리)
      const tagName = jsxNode.getTagNameNode().getText();
      componentIdentifiers.add(tagName);
      jsxContent = `<${tagName}>{children}</${tagName}>`;
    } else {
      // Fragment나 다른 경우
      jsxContent = jsxNodeToString(jsxNode);
      jsxContent = replaceOutletWithChildren(jsxContent);
      if (!jsxContent.includes('{children}')) {
        jsxContent += '{children}';
      }
      // 컴포넌트 식별자 수집
      collectComponentIdentifiers(jsxNode, sourceFile, componentIdentifiers);
    }
  } else if (routeInfo.elementValue) {
    // 하위 호환성: elementValue가 있으면 사용
    jsxContent = replaceOutletWithChildren(routeInfo.elementValue);
    if (!jsxContent.includes('{children}')) {
      // 단일 컴포넌트인 경우 감싸기
      const match = jsxContent.match(/<(\w+)([^>]*)>/);
      if (match) {
        const tagName = match[1];
        const attrs = match[2];
        componentIdentifiers.add(tagName);
        jsxContent = `<${tagName}${attrs}>{children}</${tagName}>`;
      } else {
        jsxContent += '{children}';
      }
    }
    // 컴포넌트 식별자 수집 (정규식으로)
    const componentMatches = jsxContent.matchAll(/<([A-Z][a-zA-Z0-9]*)/g);
    for (const match of componentMatches) {
      componentIdentifiers.add(match[1]);
    }
  } else {
    // fallback: 컴포넌트 이름만 사용
    const componentName = routeInfo.componentName;
    componentIdentifiers.add(componentName);
    jsxContent = `<${componentName}>{children}</${componentName}>`;
  }

  // import 문 생성 (명세 3.2.4)
  const importStatements = collectImportStatements(sourceFile, componentIdentifiers, targetFilePath);
  const importSection = importStatements.length > 0 ? importStatements.join('\n') + '\n\n' : '';

  // layout.tsx 생성 (명세 3.2.3)
  return `${importSection}export default function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    ${jsxContent}
  );
}`;
}

// ============================================================================
// 폴더 및 파일 생성
// ============================================================================

/**
 * Route 정보를 기반으로 폴더 구조 생성
 */
async function generatePageAndFolder(projectRoot, routeInfo, sourceFile, sourceFilePath, parentPath = '') {
  const appDir = path.join(projectRoot, 'src/app');

  // 경로를 폴더 구조로 변환
  let routePath = routeInfo.path;
  
  // 상대 경로인 경우 부모 경로와 결합
  if (routePath) {
    if (!routePath.startsWith('/')) {
      // 상대 경로인 경우 (예: "post", "profile")
      if (parentPath) {
        // 부모 경로가 있으면 결합 (예: "/dashboard" + "/" + "post" = "/dashboard/post")
        routePath = parentPath + '/' + routePath;
      } else {
        // 부모 경로가 없으면 절대 경로로 변환
        routePath = '/' + routePath;
      }
    } else {
      // 절대 경로는 그대로 사용
    }
  } else if (parentPath) {
    // path가 없지만 부모가 있으면 부모 경로 사용 (index route)
    routePath = parentPath;
  }

  const folderSegments = routePath
    ? pathToFolderStructure(routePath)
    : [];

  // ✅ 수정: 루트 경로 처리 (명세 2.1.1, 2.3)
  if (routePath === '/' || routeInfo.isIndex) {
    // 자식이 있으면 layout.tsx만 생성, 없으면 page.tsx 생성
    if (routeInfo.hasChildren && routeInfo.childRoutes.length > 0) {
      // 루트에 자식이 있는 경우는 드물지만, layout.tsx 생성
      const layoutPath = path.join(appDir, 'layout.tsx');
      if (!fs.existsSync(layoutPath)) {
        const layoutContent = generateLayoutContent(routeInfo, sourceFile, layoutPath);
        await fs.writeFile(layoutPath, layoutContent);
      }

      // ✅ 수정: 부모 Route가 중첩 라우트이면서 index Route를 함께 가지는 경우 (명세 2.3)
      // index Route가 있으면 해당 디렉터리 바로 아래에 page.tsx 추가 생성
      const hasIndexRoute = routeInfo.childRoutes.some(child => child.isIndex);
      if (hasIndexRoute) {
        const pagePath = path.join(appDir, 'page.tsx');
        if (!fs.existsSync(pagePath)) {
          const indexRoute = routeInfo.childRoutes.find(child => child.isIndex);
          const conditionalInfo = detectConditionalRoute(indexRoute.elementValue);
          const isConditional = !!conditionalInfo;
          const content = generatePageContent(indexRoute, sourceFile, pagePath, isConditional, conditionalInfo);
          await fs.writeFile(pagePath, content);
        }
      }
    } else {
      // 자식이 없으면 page.tsx 생성
      const pagePath = path.join(appDir, 'page.tsx');
      if (fs.existsSync(pagePath)) {
        return;
      }

      const conditionalInfo = detectConditionalRoute(routeInfo.elementValue);
      const isConditional = !!conditionalInfo;
      const content = generatePageContent(routeInfo, sourceFile, pagePath, isConditional, conditionalInfo);

      await fs.ensureDir(appDir);
      await fs.writeFile(pagePath, content);
    }
    return;
  }

  // ✅ 수정: 일반 경로 처리 (명세 2.1.1, 2.2, 2.3)
  const targetDir = path.join(appDir, ...folderSegments);

  // ✅ 수정: index Route 처리 (명세 2.1.1) - path 없이 index 속성만 있는 경우
  if (routeInfo.isIndex && !routeInfo.path && parentPath) {
    // 부모 라우트가 위치한 폴더 바로 아래에 별도 폴더 생성 없이 page.tsx 생성
    const parentDir = path.join(appDir, ...pathToFolderStructure(parentPath));
    const pagePath = path.join(parentDir, 'page.tsx');
    
    if (fs.existsSync(pagePath)) {
      return;
    }

    const conditionalInfo = detectConditionalRoute(routeInfo.elementValue);
    const isConditional = !!conditionalInfo;
    const content = generatePageContent(routeInfo, sourceFile, pagePath, isConditional, conditionalInfo);

    await fs.ensureDir(parentDir);
    await fs.writeFile(pagePath, content);
    return;
  }

  // 중첩 라우트인 경우: layout.tsx만 생성하고 자식 Route들은 재귀적으로 처리 (명세 2.2)
  if (routeInfo.hasChildren && routeInfo.childRoutes.length > 0) {
    const layoutPath = path.join(targetDir, 'layout.tsx');
    if (!fs.existsSync(layoutPath)) {
      const layoutContent = generateLayoutContent(routeInfo, sourceFile, layoutPath);
      await fs.ensureDir(targetDir);
      await fs.writeFile(layoutPath, layoutContent);
    }

    // ✅ 수정: 부모 Route가 중첩 라우트이면서 index Route를 함께 가지는 경우 (명세 2.3)
    const hasIndexRoute = routeInfo.childRoutes.some(child => child.isIndex);
    if (hasIndexRoute) {
      const pagePath = path.join(targetDir, 'page.tsx');
      if (!fs.existsSync(pagePath)) {
        const indexRoute = routeInfo.childRoutes.find(child => child.isIndex);
        const conditionalInfo = detectConditionalRoute(indexRoute.elementValue);
        const isConditional = !!conditionalInfo;
        const content = generatePageContent(indexRoute, sourceFile, pagePath, isConditional, conditionalInfo);
        await fs.writeFile(pagePath, content);
      }
    }

    // 자식 Route들 재귀적으로 처리 (index Route 제외)
    for (const childRoute of routeInfo.childRoutes) {
      // index Route는 이미 처리했으므로 제외
      if (childRoute.isIndex && !childRoute.path) {
        continue;
      }
      await generatePageAndFolder(
        projectRoot,
        childRoute,
        sourceFile,
        sourceFilePath,
        routePath
      );
    }
  } else {
    // 자식이 없으면 page.tsx 생성
    const pagePath = path.join(targetDir, 'page.tsx');

    if (fs.existsSync(pagePath)) {
      return;
    }

    const conditionalInfo = detectConditionalRoute(routeInfo.elementValue);
    const isConditional = !!conditionalInfo;
    const content = generatePageContent(routeInfo, sourceFile, pagePath, isConditional, conditionalInfo);

    await fs.ensureDir(targetDir);
    await fs.writeFile(pagePath, content);
  }
}

// ============================================================================
// useRoutes 처리
// ============================================================================

/**
 * useRoutes 배열에서 Route 객체 추출
 */
function parseRouteObjectArray(arrayNode) {
  const routes = [];

  if (arrayNode.getKind() === SyntaxKind.ArrayLiteralExpression) {
    const elements = arrayNode.getElements();
    for (const element of elements) {
      if (element.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const pathProp = element.getProperty('path');
        const elementProp = element.getProperty('element');

        const pathValue = pathProp
          ? pathProp.getInitializer()?.getText().replace(/['"]/g, '')
          : null;
        const elementValue = elementProp
          ? elementProp.getInitializer()?.getText()
          : null;

        let componentName = null;
        if (elementValue) {
          const match = elementValue.match(/<(\w+)/);
          if (match) {
            componentName = match[1];
          }
        }

        routes.push({
          path: pathValue,
          componentName,
          elementValue,
        });
      }
    }
  }

  return routes;
}

/**
 * useRoutes hook 변환
 */
async function convertUseRoutes(projectRoot, useRoutesCall, sourceFile, sourceFilePath) {
  const routeObjects = parseRouteObjectArray(useRoutesCall.arrayArg);

  for (const routeObj of routeObjects) {
    if (!routeObj.componentName) continue;

    const routeInfo = {
      path: routeObj.path || '/',
      isIndex: !routeObj.path || routeObj.path === '/',
      componentName: routeObj.componentName,
      elementValue: routeObj.elementValue,
      hasChildren: false,
    };

    await generatePageAndFolder(projectRoot, routeInfo, sourceFile, sourceFilePath);
  }
}

// ============================================================================
// 메인 마이그레이션 함수
// ============================================================================

/**
 * src 내 모든 파일에서 Route 태그 찾기
 */
async function findAllRouteFiles(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) {
    return [];
  }

  const routeFiles = [];
  const extensions = ['.tsx', '.ts', '.jsx', '.js'];
  const ignoreDirs = ['node_modules', '.next', 'dist', 'app'];

  async function findFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(srcDir, fullPath);

      if (entry.isDirectory()) {
        if (!ignoreDirs.some(ignore => relativePath.includes(ignore))) {
          await findFiles(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          routeFiles.push(fullPath);
        }
      }
    }
  }

  await findFiles(srcDir);
  return routeFiles;
}

/**
 * Route 마이그레이션 메인 함수
 */
async function migrateRoutes(projectRoot) {
  // ✅ 수정: src 내 모든 파일에서 Route 태그 탐색 (명세 1번)
  const allFiles = await findAllRouteFiles(projectRoot);

  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
  });

  // 모든 파일에서 Route 찾기
  const allRoutesFromAllFiles = [];
  for (const filePath of allFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      const routes = findAllRoutes(sourceFile);
      if (routes.length > 0) {
        routes.forEach(route => {
          route.sourceFilePath = filePath;
        });
        allRoutesFromAllFiles.push(...routes);
      }
    } catch (error) {
      // 파일 처리 오류 시 무시
    }
  }

  if (allRoutesFromAllFiles.length === 0) {
    return;
  }

  // 1. Route 태그 찾기 (최상위 Route만)
  const allRoutes = allRoutesFromAllFiles;
  
  // 최상위 Route만 필터링 (부모 Route의 자식이 아닌 것들)
  // 자식 Route는 childRoutes 배열에 포함되어 있으므로 별도로 처리할 필요 없음
  const processedChildNodes = new Set();
  
  // 모든 Route의 자식 Route 노드를 수집
  for (const route of allRoutes) {
    if (route.childRoutes && route.childRoutes.length > 0) {
      for (const childRoute of route.childRoutes) {
        processedChildNodes.add(childRoute.node);
      }
    }
  }

  const topLevelRoutes = allRoutes.filter(route => {
    const routePath = route.path || '/';

    // 이미 다른 Route의 자식으로 포함되어 있는지 확인
    if (processedChildNodes.has(route.node)) {
      return false;
    }

    // 부모가 Route Element인지 확인
    const parent = route.node.getParent();
    if (!parent) {
      return true;
    }

    const grandParent = parent.getParent();
    if (grandParent && grandParent.getKind() === SyntaxKind.JsxElement) {
      const grandParentOpening = grandParent.getOpeningElement();
      if (grandParentOpening && grandParentOpening.getTagNameNode().getText() === 'Route') {
        return false; // 부모 Route의 자식이므로 제외
      }
    }

    return true;
  });

  for (const route of topLevelRoutes) {
    const sourceFile = project.addSourceFileAtPath(route.sourceFilePath);
    await generatePageAndFolder(projectRoot, route, sourceFile, route.sourceFilePath);
  }

  // 2. useRoutes hook 찾기 (모든 파일에서)
  let totalUseRoutesCalls = 0;
  for (const filePath of allFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      const useRoutesCalls = findUseRoutesCalls(sourceFile);
      if (useRoutesCalls.length > 0) {
        for (const call of useRoutesCalls) {
          await convertUseRoutes(projectRoot, call, sourceFile, filePath);
          totalUseRoutesCalls++;
        }
      }
    } catch (error) {
      // 에러 무시
    }
  }
}

// ============================================================================
// 모듈 내보내기
// ============================================================================

module.exports = {
  migrateRoutes,
  generatePageAndFolder,
  convertUseRoutes,
  pathToFolderStructure,
  detectConditionalRoute,
};
