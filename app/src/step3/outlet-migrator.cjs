// src/step3/outlet-migrator.cjs
// Outlet 마이그레이션 모듈 (React Router → Next.js)

const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');

// ============================================================================
// Outlet 제거 및 Children 수용
// ============================================================================

/**
 * 컴포넌트에서 Outlet 태그 찾기
 */
function findOutletUsage(sourceFile) {
  const outlets = [];

  // <Outlet /> self-closing 태그
  const selfClosingOutlets = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  for (const outlet of selfClosingOutlets) {
    if (outlet.getTagNameNode().getText() === 'Outlet') {
      outlets.push({
        node: outlet,
        type: 'self-closing',
      });
    }
  }

  // <Outlet></Outlet> 태그
  const outletElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement);
  for (const element of outletElements) {
    const opening = element.getOpeningElement();
    if (opening && opening.getTagNameNode().getText() === 'Outlet') {
      outlets.push({
        node: opening,
        type: 'element',
        parent: element,
      });
    }
  }

  return outlets;
}

/**
 * 컴포넌트의 props에 children 추가
 */
function addChildrenToProps(sourceFile, componentName) {
  // 함수 선언 찾기
  const functions = sourceFile.getFunctions();
  for (const func of functions) {
    if (func.getName() === componentName) {
      const params = func.getParameters();
      if (params.length === 0) {
        // 파라미터가 없으면 추가
        func.addParameter({
          name: '{ children }',
          type: '{ children: React.ReactNode }',
        });
        return true;
      } else {
        // 파라미터가 있으면 children 추가 확인
        const firstParam = params[0];
        const paramText = firstParam.getText();
        if (!paramText.includes('children')) {
          // 기존 파라미터에 children 추가
          const newParamText = paramText.replace(
            /(\{([^}]*)\})/,
            (match, full, content) => {
              const trimmed = content.trim();
              return trimmed
                ? `{ ${trimmed}, children: React.ReactNode }`
                : '{ children: React.ReactNode }';
            }
          );
          firstParam.replaceWithText(newParamText);
          return true;
        }
      }
    }
  }

  // 화살표 함수 찾기
  const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const decl of variableDeclarations) {
    const name = decl.getName();
    if (name === componentName) {
      const initializer = decl.getInitializer();
      if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
        const params = initializer.getParameters();
        if (params.length === 0) {
          initializer.addParameter({
            name: '{ children }',
            type: '{ children: React.ReactNode }',
          });
          return true;
        } else {
          const firstParam = params[0];
          const paramText = firstParam.getText();
          if (!paramText.includes('children')) {
            const newParamText = paramText.replace(
              /(\{([^}]*)\})/,
              (match, full, content) => {
                const trimmed = content.trim();
                return trimmed
                  ? `{ ${trimmed}, children: React.ReactNode }`
                  : '{ children: React.ReactNode }';
              }
            );
            firstParam.replaceWithText(newParamText);
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Outlet을 {children}으로 교체
 */
function replaceOutletWithChildren(sourceFile) {
  let modified = false;
  const outlets = findOutletUsage(sourceFile);

  for (const outlet of outlets) {
    if (outlet.type === 'self-closing') {
      outlet.node.replaceWithText('{children}');
      modified = true;
    } else if (outlet.type === 'element') {
      outlet.parent.replaceWithText('{children}');
      modified = true;
    }
  }

  return modified;
}

/**
 * Outlet import 제거
 */
function removeOutletImport(sourceFile) {
  let modified = false;
  const imports = sourceFile.getImportDeclarations();

  for (const importDecl of imports) {
    const modulePath = importDecl.getModuleSpecifierValue();
    if (modulePath === 'react-router-dom') {
      const namedImports = importDecl.getNamedImports();
      const hasOutlet = namedImports.some(n => n.getName() === 'Outlet');

      if (hasOutlet) {
        const outletImport = namedImports.find(n => n.getName() === 'Outlet');
        if (outletImport) {
          outletImport.remove();
          modified = true;

          // 다른 import가 없으면 import 문 제거
          const remainingImports = importDecl.getNamedImports();
          const defaultImport = importDecl.getDefaultImport();
          if (remainingImports.length === 0 && !defaultImport) {
            importDecl.remove();
          }
        }
      }
    }
  }

  return modified;
}

/**
 * 레거시 레이아웃 컴포넌트 리팩토링
 */
async function refactorLegacyLayout(filePath) {
  const tsConfigPath = path.join(path.dirname(filePath), '../../tsconfig.json');
  const projectRoot = path.resolve(path.dirname(filePath), '../..');

  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
  });

  if (!fs.existsSync(filePath)) {
    return false;
  }

  const sourceFile = project.addSourceFileAtPath(filePath);
  const outlets = findOutletUsage(sourceFile);

  if (outlets.length === 0) {
    return false;
  }

  // 컴포넌트 이름 찾기
  let componentName = null;
  const functions = sourceFile.getFunctions();
  if (functions.length > 0) {
    componentName = functions[0].getName();
  } else {
    const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    for (const decl of variableDeclarations) {
      const initializer = decl.getInitializer();
      if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
        componentName = decl.getName();
        break;
      }
    }
  }

  if (!componentName) {
    console.warn(`   ⚠️ 컴포넌트 이름을 찾을 수 없습니다: ${filePath}`);
    return false;
  }

  let modified = false;

  // 1. props에 children 추가
  if (addChildrenToProps(sourceFile, componentName)) {
    modified = true;
  }

  // 2. Outlet을 {children}으로 교체
  if (replaceOutletWithChildren(sourceFile)) {
    modified = true;
  }

  // 3. Outlet import 제거
  if (removeOutletImport(sourceFile)) {
    modified = true;
  }

  if (modified) {
    await fs.writeFile(filePath, sourceFile.getFullText());
    return true;
  }

  return false;
}

// ============================================================================
// Wrapper Layout 생성
// ============================================================================

/**
 * layout.tsx 파일 생성 (Wrapper)
 */
async function generateWrapperLayout(
  projectRoot,
  layoutDir,
  componentName,
  componentImportPath
) {
  const layoutPath = path.join(layoutDir, 'layout.tsx');

  if (fs.existsSync(layoutPath)) {
    console.log(`   ⚠️ ${path.relative(projectRoot, layoutPath)} 이미 존재합니다.`);
    return false;
  }

  // import 경로 계산
  let importPath = componentImportPath;
  if (importPath && importPath.startsWith('.')) {
    const layoutDirPath = path.dirname(layoutPath);
    const componentAbsolutePath = path.resolve(
      path.dirname(componentImportPath.includes('/') ? componentImportPath : layoutDirPath),
      componentImportPath
    );
    let relativePath = path.relative(layoutDirPath, componentAbsolutePath);
    relativePath = relativePath.split(path.sep).join('/');
    if (!relativePath.startsWith('.')) {
      relativePath = './' + relativePath;
    }
    importPath = relativePath;
  }

  const layoutContent = `import ${componentName} from '${importPath || `../../components/${componentName}`}';

export default function ${componentName}Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <${componentName}>{children}</${componentName}>;
}`;

  await fs.ensureDir(layoutDir);
  await fs.writeFile(layoutPath, layoutContent);
  console.log(`   ✅ 생성: ${path.relative(projectRoot, layoutPath)}`);
  return true;
}

/**
 * Route 정보에서 layout.tsx 생성
 */
async function generateLayoutsFromRoutes(projectRoot) {
  console.log('📐 Layout 파일 생성 시작...');

  const appDir = path.join(projectRoot, 'src/app');
  if (!fs.existsSync(appDir)) {
    console.warn('⚠️ src/app 디렉토리가 없습니다.');
    return;
  }

  // 이미 생성된 page.tsx 파일들을 찾아서 해당 디렉토리에 layout.tsx가 있는지 확인
  const pageFiles = [];
  async function findPageFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await findPageFiles(fullPath);
      } else if (entry.name === 'page.tsx' || entry.name === 'page.jsx') {
        pageFiles.push(fullPath);
      }
    }
  }
  await findPageFiles(appDir);

  for (const pageFile of pageFiles) {
    const pageDir = path.dirname(pageFile);
    const layoutPath = path.join(pageDir, 'layout.tsx');

    // layout.tsx가 없고, page.tsx가 있는 경우
    if (!fs.existsSync(layoutPath)) {
      // page.tsx에서 import된 컴포넌트 확인
      const pageContent = await fs.readFile(pageFile, 'utf-8');
      const importMatch = pageContent.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);

      if (importMatch) {
        const componentName = importMatch[1];
        const importPath = importMatch[2];

        // 해당 컴포넌트 파일에서 Outlet 사용 여부 확인
        let componentFilePath = null;
        if (importPath.startsWith('.')) {
          componentFilePath = path.resolve(pageDir, importPath);
        } else if (importPath.startsWith('@/')) {
          componentFilePath = path.join(projectRoot, 'src', importPath.slice(2));
        }

        if (componentFilePath) {
          const extensions = ['.tsx', '.jsx', '.ts', '.js'];
          for (const ext of extensions) {
            const tryPath = componentFilePath + ext;
            if (fs.existsSync(tryPath)) {
              componentFilePath = tryPath;
              break;
            }
          }
        }

        if (componentFilePath && fs.existsSync(componentFilePath)) {
          const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
          const project = new Project({
            tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
            skipAddingFilesFromTsConfig: true,
          });

          const componentFile = project.addSourceFileAtPath(componentFilePath);
          const outlets = findOutletUsage(componentFile);

          // Outlet을 사용하는 컴포넌트인 경우 layout.tsx 생성
          if (outlets.length > 0) {
            await generateWrapperLayout(
              projectRoot,
              pageDir,
              componentName,
              importPath
            );
          }
        }
      }
    }
  }

  console.log('✅ Layout 파일 생성 완료');
}

// ============================================================================
// 메인 마이그레이션 함수
// ============================================================================

/**
 * Outlet 마이그레이션 메인 함수
 */
async function migrateOutlets(projectRoot) {
  console.log('🔌 Outlet 마이그레이션 시작...');

  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) {
    console.warn('⚠️ src 디렉토리가 없습니다.');
    return;
  }

  // 1. 모든 컴포넌트 파일에서 Outlet 제거 및 children 추가
  const files = [];
  const extensions = ['.tsx', '.ts', '.jsx', '.js'];
  const ignoreDirs = ['node_modules', '.next', 'dist', 'app'];

  async function findFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(srcDir, fullPath);

      // 무시할 디렉토리 체크
      if (entry.isDirectory()) {
        if (!ignoreDirs.some(ignore => relativePath.includes(ignore))) {
          await findFiles(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  await findFiles(srcDir);

  console.log(`   📁 처리할 파일: ${files.length}개`);

  let modifiedCount = 0;
  for (const file of files) {
    try {
      const modified = await refactorLegacyLayout(file);
      if (modified) {
        modifiedCount++;
        console.log(`   ✅ 수정: ${path.relative(projectRoot, file)}`);
      }
    } catch (error) {
      console.warn(`   ⚠️ 오류 발생 (${path.relative(projectRoot, file)}): ${error.message}`);
    }
  }

  console.log(`   ✅ ${modifiedCount}개 파일에서 Outlet 제거 완료`);

  // 2. Route 기반으로 layout.tsx 생성
  await generateLayoutsFromRoutes(projectRoot);

  console.log('✅ Outlet 마이그레이션 완료');
}

// ============================================================================
// 모듈 내보내기
// ============================================================================

module.exports = {
  migrateOutlets,
  refactorLegacyLayout,
  generateWrapperLayout,
  findOutletUsage,
  replaceOutletWithChildren,
};
