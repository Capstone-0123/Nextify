// src/step2/provider-generator.cjs
// Provider 탐색, 추출, 생성 및 Layout 적용 모듈
// React Query, ThemeProvider 등을 src/app/providers.tsx에 추가

const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');

// ============================================================================
// 상수 정의
// ============================================================================

/**
 * Router 관련 컴포넌트 이름 목록 (제외 대상)
 */
const ROUTER_COMPONENTS = [
  'BrowserRouter',
  'HashRouter',
  'Router',
  'Switch',
  'Routes',
  'MemoryRouter',
  'StaticRouter',
  'NativeRouter',
];

/**
 * Provider 카테고리별 키워드 매핑
 */
const PROVIDER_CATEGORIES = {
  stateManagement: {
    componentKeywords: ['Provider', 'RecoilRoot', 'JotaiProvider', 'Atom', 'Context'],
    importKeywords: ['react-redux', 'redux', 'recoil', 'jotai', 'zustand', 'mobx'],
  },
  styling: {
    componentKeywords: ['ThemeProvider', 'CacheProvider', 'NextUIProvider', 'StyleProvider'],
    importKeywords: ['styled-components', '@emotion/react', '@mui/material', '@nextui-org/react', '@chakra-ui'],
  },
  auth: {
    componentKeywords: ['AuthProvider', 'SessionProvider', 'ClerkProvider'],
    importKeywords: ['next-auth', '@clerk/nextjs', '@clerk/clerk-react', 'firebase', '@auth0'],
  },
  dataUtil: {
    componentKeywords: ['QueryClientProvider', 'SWRConfig', 'HelmetProvider', 'ApolloProvider', 'IntlProvider', 'DndProvider', 'ToastProvider', 'Toaster'],
    importKeywords: ['@tanstack/react-query', 'react-query', 'swr', 'react-helmet', '@apollo/client', 'react-intl', 'react-dnd', 'react-hot-toast', 'react-toastify', 'trpc'],
  },
};

/**
 * SSR 호환을 위한 스타일 라이브러리별 Registry 설정
 */
const STYLE_REGISTRY_CONFIG = {
  'styled-components': {
    registryComponent: 'StyledComponentsRegistry',
    registryCode: `
'use client';

import React, { useState } from 'react';
import { useServerInsertedHTML } from 'next/navigation';
import { ServerStyleSheet, StyleSheetManager } from 'styled-components';

export function StyledComponentsRegistry({ children }: { children: React.ReactNode }) {
  const [styledComponentsStyleSheet] = useState(() => new ServerStyleSheet());

  useServerInsertedHTML(() => {
    const styles = styledComponentsStyleSheet.getStyleElement();
    styledComponentsStyleSheet.instance.clearTag();
    return <>{styles}</>;
  });

  if (typeof window !== 'undefined') return <>{children}</>;

  return (
    <StyleSheetManager sheet={styledComponentsStyleSheet.instance}>
      {children}
    </StyleSheetManager>
  );
}
`,
  },
  '@emotion/react': {
    registryComponent: 'EmotionRegistry',
    registryCode: `
'use client';

import React, { useState } from 'react';
import { useServerInsertedHTML } from 'next/navigation';
import { CacheProvider } from '@emotion/react';
import createCache from '@emotion/cache';

export function EmotionRegistry({ children }: { children: React.ReactNode }) {
  const [cache] = useState(() => {
    const cache = createCache({ key: 'emotion' });
    cache.compat = true;
    return cache;
  });

  useServerInsertedHTML(() => {
    const inserted = cache.inserted;
    const styles = Object.keys(inserted).map((key) => {
      return (
        <style
          key={key}
          data-emotion={\`\${cache.key} \${key}\`}
          dangerouslySetInnerHTML={{ __html: inserted[key] as string }}
        />
      );
    });
    return <>{styles}</>;
  });

  return <CacheProvider value={cache}>{children}</CacheProvider>;
}
`,
  },
  '@mui/material': {
    registryComponent: 'MuiRegistry',
    registryCode: `
'use client';

import React from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v14-appRouter';

const theme = createTheme();

export function MuiRegistry({ children }: { children: React.ReactNode }) {
  return (
    <AppRouterCacheProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
`,
  },
};

// ============================================================================
// 1. extractProviderTree - Provider 탐색 및 추출
// ============================================================================

/**
 * 컴포넌트 이름과 import 경로를 기반으로 카테고리 분류
 */
function categorizeProvider(componentName, importPath) {
  for (const [category, config] of Object.entries(PROVIDER_CATEGORIES)) {
    if (config.componentKeywords.some(keyword => componentName.includes(keyword))) {
      return category;
    }
    if (importPath && config.importKeywords.some(keyword => importPath.includes(keyword))) {
      return category;
    }
  }
  return 'unknown';
}

/**
 * JSX Element에서 props 추출
 */
function extractPropsFromElement(jsxElement) {
  const props = [];
  const attributes = jsxElement.getAttributes();

  for (const attr of attributes) {
    if (attr.getKind() === SyntaxKind.JsxAttribute) {
      const nameNode = attr.getNameNode();
      const initializer = attr.getInitializer();

      const propName = nameNode.getText();
      let propValue = '';
      let isVariable = false;

      if (initializer) {
        if (initializer.getKind() === SyntaxKind.JsxExpression) {
          const expression = initializer.getExpression();
          if (expression) {
            propValue = expression.getText();
            isVariable = true;
          }
        } else {
          propValue = initializer.getText();
        }
      } else {
        propValue = 'true';
      }

      props.push({ name: propName, value: propValue, isVariable });
    } else if (attr.getKind() === SyntaxKind.JsxSpreadAttribute) {
      props.push({
        name: '...spread',
        value: attr.getExpression().getText(),
        isVariable: true,
      });
    }
  }

  return props;
}

/**
 * JSX 트리에서 Provider 컴포넌트들을 재귀적으로 추출
 */
function extractProvidersFromJsx(jsxNode, importMap, nestLevel = 0, providers = []) {
  if (!jsxNode) return providers;

  const kind = jsxNode.getKind();

  if (kind === SyntaxKind.JsxElement) {
    const openingElement = jsxNode.getOpeningElement();
    const tagName = openingElement.getTagNameNode().getText();

    if (!ROUTER_COMPONENTS.includes(tagName)) {
      const importPath = importMap.get(tagName) || '';
      const category = categorizeProvider(tagName, importPath);

      if (tagName.includes('Provider') ||
          tagName.includes('Root') ||
          category !== 'unknown' ||
          tagName.includes('Context') ||
          tagName.includes('Config')) {

        providers.push({
          name: tagName,
          category,
          importPath,
          props: extractPropsFromElement(openingElement),
          nestLevel,
        });
      }
    }

    const children = jsxNode.getJsxChildren();
    for (const child of children) {
      extractProvidersFromJsx(child, importMap, nestLevel + 1, providers);
    }
  }

  if (kind === SyntaxKind.JsxSelfClosingElement) {
    const tagName = jsxNode.getTagNameNode().getText();

    if (!ROUTER_COMPONENTS.includes(tagName) &&
        (tagName.includes('Provider') || tagName.includes('Toaster'))) {
      const importPath = importMap.get(tagName) || '';
      const category = categorizeProvider(tagName, importPath);

      providers.push({
        name: tagName,
        category,
        importPath,
        props: extractPropsFromElement(jsxNode),
        nestLevel,
        isSelfClosing: true,
      });
    }
  }

  if (kind === SyntaxKind.JsxFragment) {
    const children = jsxNode.getJsxChildren();
    for (const child of children) {
      extractProvidersFromJsx(child, importMap, nestLevel, providers);
    }
  }

  if (kind === SyntaxKind.ParenthesizedExpression) {
    const inner = jsxNode.getExpression();
    extractProvidersFromJsx(inner, importMap, nestLevel, providers);
  }

  return providers;
}

/**
 * 소스 파일에서 import 맵 생성 (컴포넌트명 -> import 경로)
 */
function buildImportMap(sourceFile) {
  const importMap = new Map();

  const imports = sourceFile.getImportDeclarations();
  for (const importDecl of imports) {
    const modulePath = importDecl.getModuleSpecifierValue();

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
      importMap.set(defaultImport.getText(), modulePath);
    }

    const namedImports = importDecl.getNamedImports();
    for (const namedImport of namedImports) {
      const name = namedImport.getAliasNode()?.getText() || namedImport.getName();
      importMap.set(name, modulePath);
    }

    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) {
      importMap.set(namespaceImport.getText(), modulePath);
    }
  }

  return importMap;
}

/**
 * render() 함수 내부의 JSX를 찾기
 */
function findRenderJsx(sourceFile) {
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    const expression = call.getExpression();
    const exprText = expression.getText();

    if (exprText.endsWith('.render') || exprText === 'render') {
      const args = call.getArguments();
      if (args.length > 0) {
        return args[0];
      }
    }
  }

  return null;
}

/**
 * render() 호출에서 루트 컴포넌트 이름 추출 (예: <App /> → 'App')
 */
function findRootComponentName(renderJsx) {
  if (!renderJsx) return null;

  const jsxText = renderJsx.getText();

  // <App /> 또는 <App> 패턴 찾기
  const match = jsxText.match(/<(\w+)\s*[\/|>]/);
  if (match) {
    return match[1];
  }

  return null;
}

/**
 * 컴포넌트 파일에서 return 문의 JSX 추출
 */
function findComponentReturnJsx(sourceFile) {
  // 함수 선언 찾기 (function App() { ... })
  const functions = sourceFile.getFunctions();
  for (const func of functions) {
    const returnStatements = func.getDescendantsOfKind(SyntaxKind.ReturnStatement);
    for (const ret of returnStatements) {
      const expression = ret.getExpression();
      if (expression) {
        return expression;
      }
    }
  }

  // 화살표 함수 찾기 (const App = () => { ... })
  const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const varDecl of variableDeclarations) {
    const initializer = varDecl.getInitializer();
    if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
      const body = initializer.getBody();

      // 직접 JSX 반환: () => (<div>...</div>)
      if (body.getKind() === SyntaxKind.ParenthesizedExpression ||
          body.getKind() === SyntaxKind.JsxElement ||
          body.getKind() === SyntaxKind.JsxFragment) {
        return body;
      }

      // 블록 내 return: () => { return (<div>...</div>) }
      if (body.getKind() === SyntaxKind.Block) {
        const returnStatements = body.getDescendantsOfKind(SyntaxKind.ReturnStatement);
        for (const ret of returnStatements) {
          const expression = ret.getExpression();
          if (expression) {
            return expression;
          }
        }
      }
    }
  }

  return null;
}

/**
 * 컴포넌트 파일 경로 해석
 */
function resolveComponentPath(projectRoot, importPath, fromFilePath) {
  let absolutePath;

  if (importPath.startsWith('.')) {
    // 상대 경로
    const fromDir = path.dirname(fromFilePath);
    absolutePath = path.resolve(fromDir, importPath);
  } else if (importPath.startsWith('@/')) {
    // 알리아스 경로
    absolutePath = path.join(projectRoot, 'src', importPath.slice(2));
  } else {
    // node_modules 패키지는 무시
    return null;
  }

  // 확장자 추가 시도
  const extensions = ['.tsx', '.jsx', '.ts', '.js'];
  for (const ext of extensions) {
    const tryPath = absolutePath + ext;
    if (fs.existsSync(tryPath)) {
      return tryPath;
    }
  }

  // index 파일 시도
  for (const ext of extensions) {
    const tryPath = path.join(absolutePath, `index${ext}`);
    if (fs.existsSync(tryPath)) {
      return tryPath;
    }
  }

  // 이미 확장자가 있는 경우
  if (fs.existsSync(absolutePath)) {
    return absolutePath;
  }

  return null;
}

/**
 * Provider 트리 추출 메인 함수
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
async function extractProviderTree(projectRoot) {
  console.log('🔍 Provider 트리 탐색 시작...');

  const possibleEntries = [
    path.join(projectRoot, 'src/main.tsx'),
    path.join(projectRoot, 'src/main.jsx'),
    path.join(projectRoot, 'src/index.tsx'),
    path.join(projectRoot, 'src/index.jsx'),
  ];

  let entryFilePath = null;
  for (const entry of possibleEntries) {
    if (fs.existsSync(entry)) {
      entryFilePath = entry;
      break;
    }
  }

  if (!entryFilePath) {
    console.warn('⚠️ 진입점 파일(main.tsx 또는 index.tsx)을 찾을 수 없습니다.');
    return { providers: [], entryFile: null, importMap: new Map() };
  }

  console.log(`📁 진입점 파일: ${path.relative(projectRoot, entryFilePath)}`);

  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
  });

  // 1. main.tsx 분석
  const entrySourceFile = project.addSourceFileAtPath(entryFilePath);
  const entryImportMap = buildImportMap(entrySourceFile);
  const renderJsx = findRenderJsx(entrySourceFile);

  let allProviders = [];
  let allSourceFiles = [entrySourceFile];
  let combinedImportMap = new Map(entryImportMap);

  // main.tsx에서 Provider 추출
  if (renderJsx) {
    const entryProviders = extractProvidersFromJsx(renderJsx, entryImportMap);
    allProviders.push(...entryProviders);
    console.log(`   📄 ${path.basename(entryFilePath)}: ${entryProviders.length}개 Provider 발견`);

    // 2. main.tsx에서 렌더링하는 루트 컴포넌트 찾기 (예: App)
    const rootComponentName = findRootComponentName(renderJsx);

    if (rootComponentName) {
      // 루트 컴포넌트의 import 경로 찾기
      const rootComponentImportPath = entryImportMap.get(rootComponentName);

      if (rootComponentImportPath) {
        const rootComponentFilePath = resolveComponentPath(
          projectRoot,
          rootComponentImportPath,
          entryFilePath
        );

        if (rootComponentFilePath && fs.existsSync(rootComponentFilePath)) {
          console.log(`📁 루트 컴포넌트 파일: ${path.relative(projectRoot, rootComponentFilePath)}`);

          // 3. App.tsx (루트 컴포넌트) 분석
          const rootSourceFile = project.addSourceFileAtPath(rootComponentFilePath);
          const rootImportMap = buildImportMap(rootSourceFile);
          allSourceFiles.push(rootSourceFile);

          // import 맵 병합
          for (const [key, value] of rootImportMap) {
            combinedImportMap.set(key, value);
          }

          // App.tsx의 return JSX에서 Provider 추출
          const rootReturnJsx = findComponentReturnJsx(rootSourceFile);

          if (rootReturnJsx) {
            const rootProviders = extractProvidersFromJsx(rootReturnJsx, rootImportMap);
            console.log(`   📄 ${path.basename(rootComponentFilePath)}: ${rootProviders.length}개 Provider 발견`);

            // nestLevel 조정 (main.tsx Provider 다음에 위치)
            const maxEntryLevel = allProviders.length > 0
              ? Math.max(...allProviders.map(p => p.nestLevel))
              : -1;

            for (const provider of rootProviders) {
              provider.nestLevel += maxEntryLevel + 1;
              provider.sourceFile = rootComponentFilePath;
            }

            allProviders.push(...rootProviders);
          }
        }
      }
    }
  } else {
    console.warn('⚠️ render() 호출을 찾을 수 없습니다.');
  }

  // 4. 추가로 App.tsx 직접 확인 (main.tsx에서 찾지 못한 경우)
  if (allProviders.length === 0) {
    const appFilePaths = [
      path.join(projectRoot, 'src/App.tsx'),
      path.join(projectRoot, 'src/App.jsx'),
      path.join(projectRoot, 'src/app.tsx'),
      path.join(projectRoot, 'src/app.jsx'),
    ];

    for (const appPath of appFilePaths) {
      if (fs.existsSync(appPath)) {
        console.log(`📁 App 파일 직접 탐색: ${path.relative(projectRoot, appPath)}`);

        const appSourceFile = project.addSourceFileAtPath(appPath);
        const appImportMap = buildImportMap(appSourceFile);
        allSourceFiles.push(appSourceFile);

        for (const [key, value] of appImportMap) {
          combinedImportMap.set(key, value);
        }

        const appReturnJsx = findComponentReturnJsx(appSourceFile);
        if (appReturnJsx) {
          const appProviders = extractProvidersFromJsx(appReturnJsx, appImportMap);
          console.log(`   📄 ${path.basename(appPath)}: ${appProviders.length}개 Provider 발견`);

          for (const provider of appProviders) {
            provider.sourceFile = appPath;
          }

          allProviders.push(...appProviders);
        }
        break;
      }
    }
  }

  // 중복 Provider 제거 (같은 이름)
  const uniqueProviders = [];
  const seenNames = new Set();
  for (const provider of allProviders) {
    if (!seenNames.has(provider.name)) {
      seenNames.add(provider.name);
      uniqueProviders.push(provider);
    }
  }

  // nestLevel 기준 정렬
  uniqueProviders.sort((a, b) => a.nestLevel - b.nestLevel);

  console.log(`✅ 총 ${uniqueProviders.length}개의 Provider 컴포넌트 발견`);
  for (const p of uniqueProviders) {
    console.log(`   - ${p.name} (${p.category}) [Level ${p.nestLevel}]`);
  }

  return {
    providers: uniqueProviders,
    entryFile: entryFilePath,
    importMap: combinedImportMap,
    sourceFile: entrySourceFile,
    sourceFiles: allSourceFiles,
  };
}

// ============================================================================
// 2. migrateProviderImports - Import 및 Props 이관 + Config 추적
// ============================================================================

/**
 * 원본 경로와 타깃 경로 간의 상대 경로 계산
 */
function calculateRelativePath(originalImportPath, sourceFilePath, targetFilePath) {
  if (!originalImportPath.startsWith('.')) {
    return originalImportPath;
  }

  const sourceDir = path.dirname(sourceFilePath);
  const absolutePath = path.resolve(sourceDir, originalImportPath);
  const targetDir = path.dirname(targetFilePath);
  let relativePath = path.relative(targetDir, absolutePath);

  relativePath = relativePath.split(path.sep).join('/');
  if (!relativePath.startsWith('.')) {
    relativePath = './' + relativePath;
  }

  return relativePath;
}

/**
 * 설정 객체가 new 키워드로 생성되는지 확인
 */
function isNewExpression(node) {
  if (!node) return false;
  return node.getKind() === SyntaxKind.NewExpression;
}

/**
 * 변수 선언문에서 초기화 코드 추출 및 useState 패턴 변환
 */
function extractVariableDeclaration(sourceFile, variableName) {
  const variableStatements = sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement);

  for (const statement of variableStatements) {
    const declarations = statement.getDeclarationList().getDeclarations();

    for (const decl of declarations) {
      if (decl.getName() === variableName) {
        const initializer = decl.getInitializer();
        const fullText = statement.getText();
        const usesNew = isNewExpression(initializer);

        return {
          variableName,
          fullDeclaration: fullText,
          initializer: initializer ? initializer.getText() : null,
          usesNew,
          useStatePattern: usesNew
            ? `const [${variableName}] = useState(() => ${initializer.getText()});`
            : fullText,
        };
      }
    }
  }

  return null;
}

/**
 * Provider에서 사용하는 변수들의 정의 추적
 */
function trackProviderDependencies(sourceFile, providers) {
  const dependencies = [];
  const trackedVariables = new Set();

  for (const provider of providers) {
    for (const prop of provider.props) {
      if (prop.isVariable && prop.value) {
        if (trackedVariables.has(prop.value)) continue;

        const isImported = sourceFile.getImportDeclarations().some(decl => {
          const defaultImport = decl.getDefaultImport();
          if (defaultImport && defaultImport.getText() === prop.value) return true;

          const namedImports = decl.getNamedImports();
          if (namedImports.some(n => n.getName() === prop.value || n.getAliasNode()?.getText() === prop.value)) {
            return true;
          }

          return false;
        });

        if (isImported) continue;

        const varInfo = extractVariableDeclaration(sourceFile, prop.value);
        if (varInfo) {
          dependencies.push({
            ...varInfo,
            usedBy: provider.name,
            propName: prop.name,
          });
          trackedVariables.add(prop.value);
        }
      }
    }
  }

  return dependencies;
}

/**
 * Provider가 사용하는 import 구문 수집
 */
function collectProviderImports(sourceFile, providers, targetFilePath) {
  const imports = [];
  const sourceFilePath = sourceFile.getFilePath();
  const providerNames = new Set(providers.map(p => p.name));

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const modulePath = importDecl.getModuleSpecifierValue();

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport && providerNames.has(defaultImport.getText())) {
      const newPath = calculateRelativePath(modulePath, sourceFilePath, targetFilePath);
      imports.push({
        originalPath: modulePath,
        newPath,
        defaultImport: defaultImport.getText(),
        namedImports: [],
        type: 'provider',
      });
      continue;
    }

    const namedImports = importDecl.getNamedImports();
    const matchedNamedImports = namedImports.filter(n => {
      const name = n.getAliasNode()?.getText() || n.getName();
      return providerNames.has(name);
    });

    if (matchedNamedImports.length > 0) {
      const newPath = calculateRelativePath(modulePath, sourceFilePath, targetFilePath);
      imports.push({
        originalPath: modulePath,
        newPath,
        defaultImport: null,
        namedImports: matchedNamedImports.map(n => {
          const alias = n.getAliasNode()?.getText();
          return alias ? `${n.getName()} as ${alias}` : n.getName();
        }),
        type: 'provider',
      });
    }
  }

  return imports;
}

/**
 * 의존성 변수가 사용하는 추가 import 수집
 */
function collectDependencyImports(sourceFile, dependencies, targetFilePath) {
  const imports = [];
  const sourceFilePath = sourceFile.getFilePath();

  const usedIdentifiers = new Set();

  for (const dep of dependencies) {
    if (dep.initializer) {
      const matches = dep.initializer.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
      if (matches) {
        matches.forEach(m => usedIdentifiers.add(m));
      }
    }
  }

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const modulePath = importDecl.getModuleSpecifierValue();

    const defaultImport = importDecl.getDefaultImport();
    const namedImports = importDecl.getNamedImports();

    const matchedDefault = defaultImport && usedIdentifiers.has(defaultImport.getText());
    const matchedNamed = namedImports.filter(n => {
      const name = n.getAliasNode()?.getText() || n.getName();
      return usedIdentifiers.has(name);
    });

    if (matchedDefault || matchedNamed.length > 0) {
      const newPath = calculateRelativePath(modulePath, sourceFilePath, targetFilePath);

      imports.push({
        originalPath: modulePath,
        newPath,
        defaultImport: matchedDefault ? defaultImport.getText() : null,
        namedImports: matchedNamed.map(n => {
          const alias = n.getAliasNode()?.getText();
          return alias ? `${n.getName()} as ${alias}` : n.getName();
        }),
        type: 'dependency',
      });
    }
  }

  return imports;
}

/**
 * Import 구문 문자열 생성
 */
function generateImportStatements(imports) {
  const mergedImports = new Map();

  for (const imp of imports) {
    const key = imp.newPath;

    if (!mergedImports.has(key)) {
      mergedImports.set(key, {
        path: imp.newPath,
        defaultImport: imp.defaultImport,
        namedImports: new Set(imp.namedImports),
      });
    } else {
      const existing = mergedImports.get(key);
      if (imp.defaultImport && !existing.defaultImport) {
        existing.defaultImport = imp.defaultImport;
      }
      imp.namedImports.forEach(n => existing.namedImports.add(n));
    }
  }

  const statements = [];

  for (const [, imp] of mergedImports) {
    const parts = [];

    if (imp.defaultImport) {
      parts.push(imp.defaultImport);
    }

    if (imp.namedImports.size > 0) {
      parts.push(`{ ${[...imp.namedImports].join(', ')} }`);
    }

    if (parts.length > 0) {
      statements.push(`import ${parts.join(', ')} from '${imp.path}';`);
    }
  }

  return statements;
}

/**
 * useState import가 필요한지 확인
 */
function needsUseStateImport(dependencies) {
  return dependencies.some(dep => dep.usesNew);
}

/**
 * 설정 코드 생성 (함수 내부용)
 */
function generateConfigCode(dependencies) {
  const codes = [];

  for (const dep of dependencies) {
    if (dep.usesNew) {
      codes.push(`  ${dep.useStatePattern}`);
    } else {
      codes.push(`  ${dep.fullDeclaration}`);
    }
  }

  return codes;
}

/**
 * Import 및 Props 이관 메인 함수
 * @param {Object[]} sourceFiles - 분석할 소스 파일들 (main.tsx, App.tsx 등)
 */
async function migrateProviderImports(projectRoot, providers, sourceFiles, entryFile) {
  console.log('📦 Import 및 설정 이관 시작...');

  const targetFilePath = path.join(projectRoot, 'src/app/providers.tsx');

  // 배열이 아니면 배열로 변환 (하위 호환성)
  const files = Array.isArray(sourceFiles) ? sourceFiles : [sourceFiles];

  // 모든 소스 파일에서 Provider import 수집
  let allProviderImports = [];
  let allDependencies = [];
  let allDependencyImports = [];

  for (const sourceFile of files) {
    const providerImports = collectProviderImports(sourceFile, providers, targetFilePath);
    allProviderImports.push(...providerImports);

    const dependencies = trackProviderDependencies(sourceFile, providers);
    allDependencies.push(...dependencies);

    const dependencyImports = collectDependencyImports(sourceFile, dependencies, targetFilePath);
    allDependencyImports.push(...dependencyImports);
  }

  console.log(`   - Provider import ${allProviderImports.length}개 수집`);
  console.log(`   - 설정 변수 ${allDependencies.length}개 추적`);
  console.log(`   - 의존성 import ${allDependencyImports.length}개 수집`);

  const allImports = [...allProviderImports, ...allDependencyImports];
  const importStatements = generateImportStatements(allImports);

  if (needsUseStateImport(allDependencies)) {
    const hasUseState = importStatements.some(s => s.includes('useState'));
    if (!hasUseState) {
      importStatements.unshift("import { useState } from 'react';");
    }
  }

  const configCodes = generateConfigCode(allDependencies);

  console.log('✅ Import 및 설정 이관 완료');

  return {
    imports: importStatements,
    configCodes,
    dependencies: allDependencies,
  };
}

// ============================================================================
// 3. generateProvidersFile - Provider 파일 생성 + SSR Registry
// ============================================================================

/**
 * package.json에서 사용 중인 스타일 라이브러리 감지
 */
async function detectStyleLibrary(projectRoot) {
  const packageJsonPath = path.join(projectRoot, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  const packageJson = await fs.readJson(packageJsonPath);
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  for (const lib of Object.keys(STYLE_REGISTRY_CONFIG)) {
    if (allDeps[lib]) {
      return lib;
    }
  }

  return null;
}

/**
 * Provider JSX 문자열 생성 (중첩 구조)
 */
function generateProviderJsx(providers, childrenVar = 'children') {
  if (providers.length === 0) {
    return `{${childrenVar}}`;
  }

  let jsx = `{${childrenVar}}`;
  const reversedProviders = [...providers].reverse();

  for (const provider of reversedProviders) {
    if (provider.isSelfClosing) continue;

    const propsStr = provider.props
      .filter(p => p.name !== 'children')
      .map(p => {
        if (p.name === '...spread') {
          return `{...${p.value}}`;
        }
        if (p.isVariable) {
          return `${p.name}={${p.value}}`;
        }
        return `${p.name}=${p.value}`;
      })
      .join(' ');

    const propsSection = propsStr ? ` ${propsStr}` : '';
    jsx = `<${provider.name}${propsSection}>\n        ${jsx}\n      </${provider.name}>`;
  }

  return jsx;
}

/**
 * Self-closing Provider들 (Toaster 등) JSX 생성
 */
function generateSelfClosingProviders(providers) {
  const selfClosing = providers.filter(p => p.isSelfClosing);

  if (selfClosing.length === 0) return '';

  return selfClosing.map(p => {
    const propsStr = p.props
      .map(prop => {
        if (prop.name === '...spread') {
          return `{...${prop.value}}`;
        }
        if (prop.isVariable) {
          return `${prop.name}={${prop.value}}`;
        }
        return `${prop.name}=${prop.value}`;
      })
      .join(' ');

    return `<${p.name}${propsStr ? ` ${propsStr}` : ''} />`;
  }).join('\n        ');
}

/**
 * providers.tsx 파일 생성 메인 함수
 */
async function generateProvidersFile(projectRoot, providers, options = {}) {
  console.log('📝 providers.tsx 파일 생성 시작...');

  const { imports = [], configCodes = [] } = options;
  const targetPath = path.join(projectRoot, 'src/app/providers.tsx');

  const styleLibrary = await detectStyleLibrary(projectRoot);
  let registryComponent = null;
  let registryFilePath = null;

  if (styleLibrary && STYLE_REGISTRY_CONFIG[styleLibrary]) {
    const config = STYLE_REGISTRY_CONFIG[styleLibrary];
    registryComponent = config.registryComponent;
    registryFilePath = path.join(projectRoot, 'src/app/registry.tsx');

    await fs.ensureDir(path.dirname(registryFilePath));
    await fs.writeFile(registryFilePath, config.registryCode.trim());
    console.log(`✅ SSR Registry 생성: src/app/registry.tsx (${styleLibrary})`);
  }

  const providerJsx = generateProviderJsx(providers);
  const selfClosingJsx = generateSelfClosingProviders(providers);

  const importLines = [
    "'use client';",
    '',
    "import React from 'react';",
  ];

  if (registryComponent) {
    importLines.push(`import { ${registryComponent} } from './registry';`);
  }

  if (imports.length > 0) {
    importLines.push('');
    importLines.push(...imports);
  }

  const configSection = configCodes.length > 0
    ? '\n' + configCodes.join('\n\n') + '\n'
    : '';

  let finalJsx = providerJsx;
  if (registryComponent) {
    finalJsx = `<${registryComponent}>\n        ${providerJsx}\n      </${registryComponent}>`;
  }

  const selfClosingSection = selfClosingJsx
    ? `\n        ${selfClosingJsx}`
    : '';

  const fileContent = `${importLines.join('\n')}
${configSection}
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <>
      ${finalJsx}${selfClosingSection}
    </>
  );
}
`;

  await fs.ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, fileContent.trim());

  console.log('✅ 생성 완료: src/app/providers.tsx');

  return {
    providersPath: targetPath,
    registryPath: registryFilePath,
    styleLibrary,
  };
}

// ============================================================================
// 4. applyProvidersToLayout - RootLayout에 Providers 적용
// ============================================================================

/**
 * layout.tsx에 Providers 적용 메인 함수
 */
async function applyProvidersToLayout(projectRoot) {
  console.log('🔧 RootLayout에 Providers 적용 시작...');

  const layoutPath = path.join(projectRoot, 'src/app/layout.tsx');
  const providersPath = path.join(projectRoot, 'src/app/providers.tsx');

  if (!fs.existsSync(layoutPath)) {
    console.warn('⚠️ src/app/layout.tsx가 없습니다. Providers 적용을 건너뜁니다.');
    return false;
  }

  if (!fs.existsSync(providersPath)) {
    console.warn('⚠️ src/app/providers.tsx가 없습니다. Providers 적용을 건너뜁니다.');
    return false;
  }

  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
  });

  const layoutFile = project.addSourceFileAtPath(layoutPath);

  const existingImport = layoutFile.getImportDeclaration(decl => {
    const specifier = decl.getModuleSpecifierValue();
    return specifier === './providers' || specifier.includes('providers');
  });

  if (!existingImport) {
    layoutFile.addImportDeclaration({
      namedImports: ['Providers'],
      moduleSpecifier: './providers',
    });
    console.log('   - import { Providers } 구문 추가');
  }

  let layoutContent = layoutFile.getFullText();

  if (layoutContent.includes('<Providers>')) {
    console.log('   - Providers가 이미 적용되어 있습니다.');
    return true;
  }

  const patterns = [
    {
      regex: /(<div[^>]*id=["']root["'][^>]*>)\s*\{children\}\s*(<\/div>)/g,
      replacement: '$1<Providers>{children}</Providers>$2',
    },
    {
      regex: /(<body[^>]*>)([\s\S]*?)\{children\}([\s\S]*?)(<\/body>)/g,
      replacement: (match, bodyOpen, before, after, bodyClose) => {
        if (before.includes('Providers') || after.includes('Providers')) {
          return match;
        }
        return `${bodyOpen}${before}<Providers>{children}</Providers>${after}${bodyClose}`;
      },
    },
    {
      regex: /\{children\}/g,
      replacement: '<Providers>{children}</Providers>',
      single: true,
    },
  ];

  let modified = false;

  for (const pattern of patterns) {
    if (pattern.single) {
      const match = layoutContent.match(pattern.regex);
      if (match && !modified) {
        layoutContent = layoutContent.replace(pattern.regex, pattern.replacement);
        modified = true;
        break;
      }
    } else {
      const before = layoutContent;
      layoutContent = layoutContent.replace(pattern.regex, pattern.replacement);
      if (layoutContent !== before) {
        modified = true;
        break;
      }
    }
  }

  if (!modified) {
    console.warn('⚠️ {children} 패턴을 찾지 못했습니다. 수동 수정이 필요합니다.');
    return false;
  }

  await fs.writeFile(layoutPath, layoutContent);

  console.log('✅ RootLayout에 Providers 적용 완료');
  return true;
}

// ============================================================================
// 통합 실행 함수
// ============================================================================

/**
 * Provider 마이그레이션 전체 프로세스 실행
 */
async function migrateProviders(projectRoot) {
  // 1. Provider 트리 추출
  const { providers, entryFile, sourceFiles } = await extractProviderTree(projectRoot);

  if (providers.length === 0) {
    console.log('⚠️ 마이그레이션할 Provider가 없습니다.');
    return;
  }

  // 2. Import 및 설정 이관 (모든 소스 파일에서 수집)
  const { imports, configCodes } = await migrateProviderImports(
    projectRoot,
    providers,
    sourceFiles,
    entryFile
  );

  // 3. providers.tsx 파일 생성 (SSR Registry 포함)
  await generateProvidersFile(projectRoot, providers, {
    imports,
    configCodes,
  });

  // 4. layout.tsx에 Providers 적용
  await applyProvidersToLayout(projectRoot);
}

// ============================================================================
// 모듈 내보내기
// ============================================================================

module.exports = {
  // 메인 통합 함수
  migrateProviders,

  // 개별 모듈 세부 기능 함수들
  extractProviderTree,
  generateProvidersFile,
  migrateProviderImports,
  applyProvidersToLayout,

  // 상수
  ROUTER_COMPONENTS,
  PROVIDER_CATEGORIES,
  STYLE_REGISTRY_CONFIG,
};
