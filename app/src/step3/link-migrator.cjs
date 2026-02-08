// src/step3/link-migrator.cjs
// Link 마이그레이션 모듈 (React Router → Next.js)

const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');

// ============================================================================
// Link 태그 변환
// ============================================================================

/**
 * Link 태그의 to 속성을 href로 변환
 */
function migrateLinkTag(sourceFile) {
  let modified = false;
  const fullText = sourceFile.getFullText();

  // Link 태그 찾기
  const linkElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  const linkElements2 = sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement);

  const allLinks = [...linkElements, ...linkElements2.map(e => e.getOpeningElement())];

  for (const link of allLinks) {
    const tagName = link.getTagNameNode().getText();
    if (tagName === 'Link') {
      const toAttr = link.getAttribute('to');
      if (toAttr) {
        const hrefAttr = link.getAttribute('href');
        if (!hrefAttr) {
          // to 속성을 href로 변경
          const toInitializer = toAttr.getInitializer();
          if (toInitializer) {
            toAttr.getNameNode().replaceWithText('href');
            modified = true;
          }
        }
      }
    }
  }

  return modified;
}

/**
 * Link import 문 변환 (react-router-dom → next/link)
 */
function migrateLinkImport(sourceFile) {
  let modified = false;

  const imports = sourceFile.getImportDeclarations();
  for (const importDecl of imports) {
    const modulePath = importDecl.getModuleSpecifierValue();

    if (modulePath === 'react-router-dom') {
      const namedImports = importDecl.getNamedImports();
      const hasLink = namedImports.some(n => n.getName() === 'Link');

      if (hasLink) {
        // Link를 제거하고 next/link에서 import 추가
        const otherImports = namedImports.filter(n => n.getName() !== 'Link');

        if (otherImports.length > 0) {
          // 다른 import가 있으면 Link만 제거
          const linkImport = namedImports.find(n => n.getName() === 'Link');
          if (linkImport) {
            linkImport.remove();
            modified = true;
          }
        } else {
          // Link만 있으면 import 문 제거
          importDecl.remove();
          modified = true;
        }

        // next/link import 추가
        const existingNextLink = sourceFile.getImportDeclaration(
          decl => decl.getModuleSpecifierValue() === 'next/link'
        );

        if (!existingNextLink) {
          sourceFile.addImportDeclaration({
            defaultImport: 'Link',
            moduleSpecifier: 'next/link',
          });
          modified = true;
        }
      }
    }
  }

  return modified;
}

// ============================================================================
// NavLink 변환
// ============================================================================

/**
 * NavLink를 Link로 변환하고 usePathname 추가
 */
function migrateNavLink(sourceFile) {
  let modified = false;

  // NavLink 태그 찾기
  const navLinkElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  const navLinkElements2 = sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement);

  const allNavLinks = [
    ...navLinkElements,
    ...navLinkElements2.map(e => e.getOpeningElement()),
  ];

  for (const navLink of allNavLinks) {
    const tagName = navLink.getTagNameNode().getText();
    if (tagName === 'NavLink') {
      // NavLink → Link로 변경
      navLink.getTagNameNode().replaceWithText('Link');
      modified = true;

      // to → href 변환
      const toAttr = navLink.getAttribute('to');
      if (toAttr) {
        toAttr.getNameNode().replaceWithText('href');
      }

      // className 함수 처리
      const classNameAttr = navLink.getAttribute('className');
      if (classNameAttr) {
        const initializer = classNameAttr.getInitializer();
        if (initializer) {
          const initText = initializer.getText();
          // className={({ isActive }) => ...} 패턴 찾기
          if (initText.includes('isActive')) {
            // usePathname hook 추가 필요 (함수 내부에서 처리)
            // 여기서는 주석으로 표시
            const parentFunction = navLink.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
              navLink.getFirstAncestorByKind(SyntaxKind.ArrowFunction);

            if (parentFunction) {
              // usePathname import 확인 및 추가
              const hasUsePathname = sourceFile.getImportDeclaration(
                decl => {
                  const named = decl.getNamedImports();
                  return named.some(n => n.getName() === 'usePathname');
                }
              );

              if (!hasUsePathname) {
                const nextNavImport = sourceFile.getImportDeclaration(
                  decl => decl.getModuleSpecifierValue() === 'next/navigation'
                );

                if (nextNavImport) {
                  nextNavImport.addNamedImport('usePathname');
                } else {
                  sourceFile.addImportDeclaration({
                    namedImports: ['usePathname'],
                    moduleSpecifier: 'next/navigation',
                  });
                }
              }

              // className 함수를 pathname 기반으로 변환
              // className={({ isActive }) => isActive ? 'on' : 'off'}
              // → className={pathname === href ? 'on' : 'off'}
              const hrefValue = toAttr?.getInitializer()?.getText().replace(/['"]/g, '') || '';
              const newClassName = initText.replace(
                /\(\s*\{\s*isActive\s*\}\s*\)\s*=>\s*(.+)/,
                `pathname === '${hrefValue}' ? $1 : (${initText.match(/:\s*(.+)/)?.[1] || "''"})`
              );

              // TODO: 더 정확한 변환을 위해서는 AST 변환이 필요
              // 여기서는 주석으로 표시
              classNameAttr.getInitializer()?.replaceWithText(
                `{/* TODO: Convert className function: ${initText} */}`
              );
            }
          }
        }
      }
    }
  }

  // NavLink import 제거
  const imports = sourceFile.getImportDeclarations();
  for (const importDecl of imports) {
    const modulePath = importDecl.getModuleSpecifierValue();
    if (modulePath === 'react-router-dom') {
      const namedImports = importDecl.getNamedImports();
      const hasNavLink = namedImports.some(n => n.getName() === 'NavLink');

      if (hasNavLink) {
        const navLinkImport = namedImports.find(n => n.getName() === 'NavLink');
        if (navLinkImport) {
          navLinkImport.remove();
          modified = true;
        }
      }
    }
  }

  return modified;
}

// ============================================================================
// useNavigate 변환
// ============================================================================

/**
 * useNavigate를 useRouter로 변환
 */
function migrateUseNavigate(sourceFile) {
  let modified = false;

  // useNavigate import 찾기
  const imports = sourceFile.getImportDeclarations();
  let hasUseNavigate = false;

  for (const importDecl of imports) {
    const modulePath = importDecl.getModuleSpecifierValue();
    if (modulePath === 'react-router-dom') {
      const namedImports = importDecl.getNamedImports();
      const useNavigateImport = namedImports.find(n => n.getName() === 'useNavigate');
      if (useNavigateImport) {
        hasUseNavigate = true;
        useNavigateImport.remove();
        modified = true;
      }
    }
  }

  if (!hasUseNavigate) {
    return false;
  }

  // useRouter import 추가
  const existingNextNav = sourceFile.getImportDeclaration(
    decl => decl.getModuleSpecifierValue() === 'next/navigation'
  );

  if (existingNextNav) {
    const hasUseRouter = existingNextNav.getNamedImports().some(n => n.getName() === 'useRouter');
    if (!hasUseRouter) {
      existingNextNav.addNamedImport('useRouter');
      modified = true;
    }
  } else {
    sourceFile.addImportDeclaration({
      namedImports: ['useRouter'],
      moduleSpecifier: 'next/navigation',
    });
    modified = true;
  }

  // useNavigate() 호출을 useRouter()로 변경
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    const expression = call.getExpression();
    if (expression.getText() === 'useNavigate') {
      expression.replaceWithText('useRouter');
      modified = true;
    }
  }

  // navigate 변수 선언 찾기 및 router로 변경
  const variableStatements = sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement);
  for (const stmt of variableStatements) {
    const declarations = stmt.getDeclarationList().getDeclarations();
    for (const decl of declarations) {
      const initializer = decl.getInitializer();
      if (initializer && initializer.getText() === 'useNavigate()') {
        const varName = decl.getName();
        // 변수명을 router로 변경 (또는 유지)
        // navigate() 호출을 router.push() 또는 router.back()으로 변경
        const navigateCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
        for (const navCall of navigateCalls) {
          const navExpr = navCall.getExpression();
          if (navExpr.getText() === `${varName}`) {
            const args = navCall.getArguments();
            if (args.length > 0) {
              const argText = args[0].getText();
              // navigate(-1) → router.back()
              if (argText === '-1') {
                navExpr.replaceWithText('router.back');
                navCall.getArguments()[0].remove();
              } else {
                // navigate('/path') → router.push('/path')
                navExpr.replaceWithText('router.push');
              }
            }
          }
        }
        modified = true;
      }
    }
  }

  return modified;
}

// ============================================================================
// 파일 처리
// ============================================================================

/**
 * 단일 파일에서 Link 관련 마이그레이션 수행
 */
async function migrateFileLinks(filePath) {
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
  let modified = false;

  // 1. Link import 및 태그 변환
  if (migrateLinkImport(sourceFile) || migrateLinkTag(sourceFile)) {
    modified = true;
  }

  // 2. NavLink 변환
  if (migrateNavLink(sourceFile)) {
    modified = true;
  }

  // 3. useNavigate 변환
  if (migrateUseNavigate(sourceFile)) {
    modified = true;
  }

  if (modified) {
    await fs.writeFile(filePath, sourceFile.getFullText());
    return true;
  }

  return false;
}

// ============================================================================
// 메인 마이그레이션 함수
// ============================================================================

/**
 * Link 마이그레이션 메인 함수
 */
async function migrateLinks(projectRoot) {
  console.log('🔗 Link 마이그레이션 시작...');

  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) {
    console.warn('⚠️ src 디렉토리가 없습니다.');
    return;
  }

  // 모든 .tsx, .ts, .jsx, .js 파일 찾기 (재귀적으로)
  const files = [];
  const extensions = ['.tsx', '.ts', '.jsx', '.js'];
  const ignoreDirs = ['node_modules', '.next', 'dist'];

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
      const modified = await migrateFileLinks(file);
      if (modified) {
        modifiedCount++;
        console.log(`   ✅ 수정: ${path.relative(projectRoot, file)}`);
      }
    } catch (error) {
      console.warn(`   ⚠️ 오류 발생 (${path.relative(projectRoot, file)}): ${error.message}`);
    }
  }

  console.log(`✅ Link 마이그레이션 완료 (${modifiedCount}개 파일 수정)`);
}

// ============================================================================
// 모듈 내보내기
// ============================================================================

module.exports = {
  migrateLinks,
  migrateFileLinks,
  migrateLinkTag,
  migrateNavLink,
  migrateUseNavigate,
};
