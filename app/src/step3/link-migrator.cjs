// src/step3/link-migrator.cjs
// Link 마이그레이션 모듈 (React Router → Next.js)

const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');

// ============================================================================
// Link 태그 변환
// ============================================================================

/**
 * Link 태그의 to 속성을 href로 변환 (명세 a)
 */
function migrateLinkTag(sourceFile) {
  let modified = false;
  const linkLikeTagNames = new Set(['Link']);

  // styled(Link) / styled(Link)<...> / styled(Link).attrs(...) 계열 선언의 변수명을 수집한다.
  // 예) const NavItem = styled(Link)<NavItemProps>`...`
  const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const varDecl of variableDeclarations) {
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;
    const initText = initializer.getText();

    // styled(Link) + (제네릭/attrs/템플릿 리터럴) 뒤가 붙어도 허용
    if (/styled\s*\(\s*Link\s*\)/.test(initText)) {
      linkLikeTagNames.add(varDecl.getName());
    }
  }

  // Link 태그 찾기 (JsxSelfClosingElement와 JsxElement 모두)
  const linkElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  const linkElements2 = sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement);

  const allLinks = [...linkElements, ...linkElements2.map((e) => e.getOpeningElement())];

  for (const link of allLinks) {
    const tagName = link.getTagNameNode().getText();
    if (linkLikeTagNames.has(tagName)) {
      const toAttr = link.getAttribute('to');
      if (toAttr) {
        const hrefAttr = link.getAttribute('href');
        if (!hrefAttr) {
          // ✅ 수정: to 속성명을 href로 변경 (명세 a.3)
          const toInitializer = toAttr.getInitializer();
          if (toInitializer) {
            // to 속성을 href로 변경
            toAttr.getNameNode().replaceWithText('href');
            modified = true;
          }
        } else {
          // href가 이미 있으면 to 속성 제거
          toAttr.remove();
          modified = true;
        }
      }
    }
  }

  return modified;
}

/**
 * Link import 문 변환 (react-router-dom → next/link) (명세 a.1)
 */
function migrateLinkImport(sourceFile) {
  let modified = false;

  const imports = sourceFile.getImportDeclarations();
  for (const importDecl of imports) {
    const modulePath = importDecl.getModuleSpecifierValue();

    if (modulePath === 'react-router-dom') {
      const namedImports = importDecl.getNamedImports();
      const hasLink = namedImports.some((n) => n.getName() === 'Link');

      if (hasLink) {
        // ✅ 수정: Link를 제거하고 next/link에서 import 추가 (명세 a.1)
        const linkImport = namedImports.find((n) => n.getName() === 'Link');
        if (linkImport) {
          linkImport.remove();
          modified = true;
        }

        // 다른 import가 없으면 import 문 제거
        const remainingImports = importDecl.getNamedImports();
        const defaultImport = importDecl.getDefaultImport();
        if (remainingImports.length === 0 && !defaultImport) {
          importDecl.remove();
        }

        // next/link import 추가 (명세 a.1)
        const existingNextLink = sourceFile.getImportDeclaration(
          (decl) => decl.getModuleSpecifierValue() === 'next/link',
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
 * NavLink를 Link로 변환하고 usePathname 추가 (명세 b)
 */
function migrateNavLink(sourceFile) {
  let modified = false;

  // NavLink 태그 찾기
  const navLinkElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  const navLinkElements2 = sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement);

  const allNavLinks = [...navLinkElements, ...navLinkElements2.map((e) => e.getOpeningElement())];

  // ✅ 수정: NavLink → Link 변환 및 className 함수 처리 (명세 b)
  // 이미 Link로 변환된 경우도 처리하기 위해 Link 태그도 확인
  const linkElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  const linkElements2 = sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement);
  const allLinks = [...linkElements, ...linkElements2.map((e) => e.getOpeningElement())];

  // NavLink와 Link 모두 처리
  const allTagsToProcess = [
    ...allNavLinks.filter((n) => n.getTagNameNode().getText() === 'NavLink'),
    ...allLinks.filter((l) => {
      const tagName = l.getTagNameNode().getText();
      if (tagName !== 'Link') return false;
      // Link 태그 중 className에 isActive나 TODO가 있는 것만 처리
      const classNameAttr = l.getAttribute('className');
      if (classNameAttr) {
        const initializer = classNameAttr.getInitializer();
        if (initializer) {
          const initText = initializer.getText();
          return initText.includes('isActive') || initText.includes('TODO');
        }
      }
      return false;
    }),
  ];

  for (const navLink of allTagsToProcess) {
    const tagName = navLink.getTagNameNode().getText();
    const isNavLink = tagName === 'NavLink';

    // href 값 추출
    let hrefValue = '';
    if (isNavLink) {
      // ✅ 수정: NavLink → Link로 변경 (명세 b.2)
      // 여는 태그 변경
      navLink.getTagNameNode().replaceWithText('Link');
      
      // 닫는 태그도 변경 (JSXElement인 경우)
      // navLink는 JsxOpeningElement이므로, 부모 JsxElement를 찾아서 닫는 태그도 변경
      let parentJsxElement = null;
      
      // 직접 부모가 JsxElement인지 확인
      const parent = navLink.getParent();
      if (parent && parent.getKind() === SyntaxKind.JsxElement) {
        parentJsxElement = parent;
      } else {
        // 조상 중에서 찾기
        parentJsxElement = navLink.getFirstAncestorByKind(SyntaxKind.JsxElement);
      }
      
      if (parentJsxElement) {
        const closingElement = parentJsxElement.getClosingElement();
        if (closingElement) {
          const closingTagName = closingElement.getTagNameNode();
          if (closingTagName.getText() === 'NavLink') {
            closingTagName.replaceWithText('Link');
            modified = true;
          }
        }
      }
      
      modified = true;

      // ✅ 수정: to → href 변환 (명세 b.2)
      const toAttr = navLink.getAttribute('to');
      const hrefAttr = navLink.getAttribute('href'); // 이미 href가 있을 수 있음

      if (toAttr) {
        hrefValue = toAttr.getInitializer()?.getText().replace(/['"]/g, '') || '';
        toAttr.getNameNode().replaceWithText('href');
      } else if (hrefAttr) {
        // 이미 href가 있는 경우 (이전에 변환되었거나 원래 href였을 수 있음)
        hrefValue = hrefAttr.getInitializer()?.getText().replace(/['"]/g, '') || '';
      }
    } else {
      // 이미 Link인 경우 href에서 값 읽기
      const hrefAttr = navLink.getAttribute('href');
      if (hrefAttr) {
        hrefValue = hrefAttr.getInitializer()?.getText().replace(/['"]/g, '') || '';
      }
    }

    // ✅ 수정: className 함수 처리 (명세 b.3)
    const classNameAttr = navLink.getAttribute('className');
    if (classNameAttr) {
      const initializer = classNameAttr.getInitializer();
      if (initializer) {
        const initText = initializer.getText();

        // className={({ isActive }) => ...} 패턴 찾기
        // TODO 주석이 있는 경우도 처리
        if (initText.includes('isActive') || initText.includes('=>') || initText.includes('TODO')) {
          // hrefValue가 없으면 href 속성에서 다시 읽기
          if (!hrefValue) {
            const currentHrefAttr = navLink.getAttribute('href');
            if (currentHrefAttr) {
              hrefValue = currentHrefAttr.getInitializer()?.getText().replace(/['"]/g, '') || '';
            }
          }

          // hrefValue가 없으면 건너뛰기
          if (!hrefValue) {
            continue;
          }
          // 부모 함수 찾기
          const parentFunction =
            navLink.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
            navLink.getFirstAncestorByKind(SyntaxKind.FunctionExpression) ||
            navLink.getFirstAncestorByKind(SyntaxKind.ArrowFunction);

          if (parentFunction) {
            // ✅ 수정: usePathname hook 추가 (명세 b.1)
            const hasUsePathname = sourceFile.getImportDeclaration((decl) => {
              const named = decl.getNamedImports();
              return named.some((n) => n.getName() === 'usePathname');
            });

            if (!hasUsePathname) {
              const nextNavImport = sourceFile.getImportDeclaration(
                (decl) => decl.getModuleSpecifierValue() === 'next/navigation',
              );

              if (nextNavImport) {
                const hasUsePathnameInImport = nextNavImport
                  .getNamedImports()
                  .some((n) => n.getName() === 'usePathname');
                if (!hasUsePathnameInImport) {
                  nextNavImport.addNamedImport('usePathname');
                  modified = true;
                }
              } else {
                sourceFile.addImportDeclaration({
                  namedImports: ['usePathname'],
                  moduleSpecifier: 'next/navigation',
                });
                modified = true;
              }
            }

            // ✅ 수정: 함수 본문에 usePathname 주입 (명세 b.1)
            let functionBody = parentFunction.getBody();

            // Arrow function인 경우 body가 Block이 아닐 수 있음
            if (parentFunction.getKind() === SyntaxKind.ArrowFunction) {
              const arrowBody = parentFunction.getBody();
              if (arrowBody.getKind() === SyntaxKind.Block) {
                functionBody = arrowBody;
              } else {
                // 직접 JSX를 반환하는 경우: () => <div>...</div>
                // 함수를 블록으로 변환해야 함
                // 이 경우는 복잡하므로 일단 건너뜀
                functionBody = null;
              }
            }

            if (functionBody && functionBody.getKind() === SyntaxKind.Block) {
              // 이미 usePathname이 있는지 확인
              const bodyText = functionBody.getText();
              if (!bodyText.includes('usePathname()') && !bodyText.includes('const pathname')) {
                // 함수 본문 시작 부분에 const pathname = usePathname(); 추가
                const firstStatement = functionBody.getStatements()[0];
                if (firstStatement) {
                  functionBody.insertStatements(0, (writer) => {
                    writer.writeLine('const pathname = usePathname();');
                  });
                } else {
                  functionBody.addStatements((writer) => {
                    writer.writeLine('const pathname = usePathname();');
                  });
                }
                modified = true;
              }
            }

            // ✅ 수정: className 함수를 pathname === href 조건문으로 변환 (명세 b.3)
            // className={({ isActive }) => isActive ? 'on' : 'off'}
            // → className={pathname === href ? 'on' : 'off'}

            try {
              // TODO 주석이 있는 경우 처리
              if (initText.includes('TODO')) {
                // TODO 주석에서 원본 함수 추출 시도
                const todoMatch = initText.match(/TODO:\s*Convert\s*className:\s*(.+?)\s*→/);
                if (todoMatch) {
                  const originalFunc = todoMatch[1].trim();
                  // 원본 함수에서 변환 시도
                  const newClassName = originalFunc
                    .replace(
                      /\(\s*\{\s*isActive\s*\}\s*\)\s*=>\s*isActive\s*\?\s*([^:]+)\s*:\s*(.+)/,
                      `pathname === '${hrefValue}' ? $1 : $2`,
                    )
                    .replace(/isActive/g, `pathname === '${hrefValue}'`);

                  if (newClassName !== originalFunc) {
                    initializer.replaceWithText(`{${newClassName}}`);
                    modified = true;
                    continue;
                  }
                }
              }

              if (initializer.getKind() === SyntaxKind.JsxExpression) {
                const expression = initializer.getExpression();
                if (expression && expression.getKind() === SyntaxKind.ArrowFunction) {
                  // Arrow function인 경우
                  const arrowFunc = expression;
                  const params = arrowFunc.getParameters();
                  const body = arrowFunc.getBody();

                  if (params.length === 1 && body) {
                    // ({ isActive }) => ... 패턴
                    let bodyText = body.getText();

                    // isActive 사용 부분 찾기
                    if (bodyText.includes('isActive')) {
                      // 템플릿 리터럴이 포함된 경우: `px-4 py-2 rounded ${isActive ? 'bg-netflix-red text-white' : 'text-gray-300 hover:text-white'}`
                      if (bodyText.includes('`') && bodyText.includes('${')) {
                        // 템플릿 리터럴 내부의 isActive를 pathname === href로 교체
                        bodyText = bodyText.replace(
                          /\$\{\s*isActive\s*\?\s*([^:]+)\s*:\s*([^}]+)\}/g,
                          (match, trueVal, falseVal) => {
                            return `\${pathname === '${hrefValue}' ? ${trueVal.trim()} : ${falseVal.trim()}}`;
                          },
                        );
                        bodyText = bodyText.replace(/isActive/g, `pathname === '${hrefValue}'`);
                        initializer.replaceWithText(`{${bodyText}}`);
                        modified = true;
                      } else {
                        // 일반 삼항 연산자 패턴: isActive ? 'on' : 'off'
                        // 템플릿 리터럴이 아닌 경우도 처리
                        const ternaryMatch = bodyText.match(/isActive\s*\?\s*([^:]+)\s*:\s*(.+)/);
                        if (ternaryMatch) {
                          const trueValue = ternaryMatch[1].trim();
                          const falseValue = ternaryMatch[2].trim();
                          const newExpression = `pathname === '${hrefValue}' ? ${trueValue} : ${falseValue}`;
                          // 전체 arrow function을 조건문으로 교체
                          initializer.replaceWithText(`{${newExpression}}`);
                          modified = true;
                        } else {
                          // 다른 패턴: isActive && 'on' 또는 !isActive && 'off'
                          bodyText = bodyText.replace(/isActive/g, `pathname === '${hrefValue}'`);
                          initializer.replaceWithText(`{${bodyText}}`);
                          modified = true;
                        }
                      }
                    }
                  }
                } else if (expression) {
                  // 함수가 아닌 경우 - 직접 변환
                  const exprText = expression.getText();
                  if (exprText.includes('isActive')) {
                    const newExpr = exprText.replace(/isActive/g, `pathname === '${hrefValue}'`);
                    expression.replaceWithText(newExpr);
                    modified = true;
                  }
                }
              } else {
                // JsxExpression이 아닌 경우 - 텍스트 기반 변환
                let newClassName = initText;

                // 템플릿 리터럴 패턴 처리
                if (initText.includes('`') && initText.includes('${')) {
                  newClassName = initText.replace(
                    /\$\{\s*isActive\s*\?\s*([^:]+)\s*:\s*([^}]+)\}/g,
                    (match, trueVal, falseVal) => {
                      return `\${pathname === '${hrefValue}' ? ${trueVal.trim()} : ${falseVal.trim()}}`;
                    },
                  );
                  newClassName = newClassName.replace(/isActive/g, `pathname === '${hrefValue}'`);
                } else {
                  // 일반 함수 패턴
                  newClassName = initText
                    .replace(
                      /\(\s*\{\s*isActive\s*\}\s*\)\s*=>\s*isActive\s*\?\s*([^:]+)\s*:\s*(.+)/,
                      `pathname === '${hrefValue}' ? $1 : $2`,
                    )
                    .replace(/isActive/g, `pathname === '${hrefValue}'`);
                }

                if (newClassName !== initText && !newClassName.includes('TODO')) {
                  initializer.replaceWithText(`{${newClassName}}`);
                  modified = true;
                }
              }
            } catch (error) {
              // AST 변환 실패 시 텍스트 기반 변환
              let newClassName = initText;

              // 템플릿 리터럴 패턴 처리
              if (initText.includes('`') && initText.includes('${')) {
                newClassName = initText.replace(
                  /\$\{\s*isActive\s*\?\s*([^:]+)\s*:\s*([^}]+)\}/g,
                  (match, trueVal, falseVal) => {
                    return `\${pathname === '${hrefValue}' ? ${trueVal.trim()} : ${falseVal.trim()}}`;
                  },
                );
                newClassName = newClassName.replace(/isActive/g, `pathname === '${hrefValue}'`);
              } else {
                // 일반 함수 패턴
                newClassName = initText
                  .replace(
                    /\(\s*\{\s*isActive\s*\}\s*\)\s*=>\s*isActive\s*\?\s*([^:]+)\s*:\s*(.+)/,
                    `pathname === '${hrefValue}' ? $1 : $2`,
                  )
                  .replace(/isActive/g, `pathname === '${hrefValue}'`);
              }

              if (newClassName !== initText && !newClassName.includes('TODO')) {
                try {
                  initializer.replaceWithText(`{${newClassName}}`);
                  modified = true;
                } catch (e) {
                  // 변환 실패 시 무시
                }
              }
            }
          }
        }
      }
    }
  }

  // ✅ 수정: NavLink import 제거 (명세 b)
  const imports = sourceFile.getImportDeclarations();
  for (const importDecl of imports) {
    const modulePath = importDecl.getModuleSpecifierValue();
    if (modulePath === 'react-router-dom') {
      const namedImports = importDecl.getNamedImports();
      const hasNavLink = namedImports.some((n) => n.getName() === 'NavLink');

      if (hasNavLink) {
        const navLinkImport = namedImports.find((n) => n.getName() === 'NavLink');
        if (navLinkImport) {
          navLinkImport.remove();
          modified = true;
        }

        // 다른 import가 없으면 import 문 제거
        const remainingImports = importDecl.getNamedImports();
        const defaultImport = importDecl.getDefaultImport();
        if (remainingImports.length === 0 && !defaultImport) {
          importDecl.remove();
        }
      }
    }
  }

  // ✅ 수정: next/link import 추가 (NavLink가 Link로 변환되었으므로)
  const hasNavLinkInCode =
    sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement).some((e) => {
      const opening = e.getOpeningElement();
      return opening && opening.getTagNameNode().getText() === 'NavLink';
    }) ||
    sourceFile
      .getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
      .some((e) => e.getTagNameNode().getText() === 'NavLink');

  if (!hasNavLinkInCode && modified) {
    const existingNextLink = sourceFile.getImportDeclaration((decl) => decl.getModuleSpecifierValue() === 'next/link');

    if (!existingNextLink) {
      sourceFile.addImportDeclaration({
        defaultImport: 'Link',
        moduleSpecifier: 'next/link',
      });
      modified = true;
    }
  }

  return modified;
}

/**
 * styled(NavLink) 같은 식별자 사용처를 styled(Link)로 변환
 * JSX 태그 변환과 별개로 처리해야 "Cannot find name 'NavLink'"를 방지할 수 있다.
 */
function migrateStyledNavLinkReferences(sourceFile) {
  let modified = false;

  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    const expressionText = call.getExpression().getText();
    if (!expressionText.startsWith('styled')) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    const firstArg = args[0];
    if (firstArg.getKind() === SyntaxKind.Identifier && firstArg.getText() === 'NavLink') {
      firstArg.replaceWithText('Link');
      modified = true;
    }
  }

  if (!modified) return false;

  // react-router-dom에서 NavLink import 제거
  const imports = sourceFile.getImportDeclarations();
  for (const importDecl of imports) {
    if (importDecl.getModuleSpecifierValue() !== 'react-router-dom') continue;
    const navImport = importDecl.getNamedImports().find((n) => n.getName() === 'NavLink');
    if (navImport) {
      navImport.remove();
    }
    if (importDecl.getNamedImports().length === 0 && !importDecl.getDefaultImport()) {
      importDecl.remove();
    }
  }

  // next/link의 Link import 보장
  const existingNextLink = sourceFile.getImportDeclaration(
    (decl) => decl.getModuleSpecifierValue() === 'next/link',
  );
  if (!existingNextLink) {
    sourceFile.addImportDeclaration({
      defaultImport: 'Link',
      moduleSpecifier: 'next/link',
    });
  }

  return true;
}

// ============================================================================
// useNavigate 변환
// ============================================================================

/**
 * useNavigate를 useRouter로 변환 (명세 c)
 */
function migrateUseNavigate(sourceFile) {
  let modified = false;

  // ✅ 수정: useNavigate import 찾기 및 제거 (명세 c.1)
  const imports = sourceFile.getImportDeclarations();
  let hasUseNavigate = false;

  for (const importDecl of imports) {
    const modulePath = importDecl.getModuleSpecifierValue();
    if (modulePath === 'react-router-dom') {
      const namedImports = importDecl.getNamedImports();
      const useNavigateImport = namedImports.find((n) => n.getName() === 'useNavigate');
      if (useNavigateImport) {
        hasUseNavigate = true;
        useNavigateImport.remove();
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

  if (!hasUseNavigate) {
    return false;
  }

  // ✅ 수정: useRouter import 추가 (명세 c.2)
  const existingNextNav = sourceFile.getImportDeclaration(
    (decl) => decl.getModuleSpecifierValue() === 'next/navigation',
  );

  if (existingNextNav) {
    const hasUseRouter = existingNextNav.getNamedImports().some((n) => n.getName() === 'useRouter');
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

  // ✅ 수정: useNavigate() 호출을 useRouter()로 변경 (명세 c.3)
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExpressions) {
    const expression = call.getExpression();
    if (expression.getText() === 'useNavigate') {
      expression.replaceWithText('useRouter');
      modified = true;
    }
  }

  // ✅ 수정: navigate 변수 선언 찾기 및 navigate() 호출 변환 (명세 c.4, c.5)
  const variableStatements = sourceFile.getDescendantsOfKind(SyntaxKind.VariableStatement);
  const navigateVariableNames = new Set(); // 원래 변수명 Set (변경 전에 저장)

  for (const stmt of variableStatements) {
    const declarations = stmt.getDeclarationList().getDeclarations();
    for (const decl of declarations) {
      const initializer = decl.getInitializer();
      if (initializer) {
        // useNavigate/useRouter로 직접 초기화된 "훅 변수"만 대상으로 제한
        // (컴포넌트 전체 함수 본문 문자열에 useRouter()가 포함된 경우까지
        // 잘못 매칭되어 컴포넌트 이름을 router로 바꾸는 버그 방지)
        const isDirectHookCall =
          initializer.getKind() === SyntaxKind.CallExpression &&
          ['useNavigate', 'useRouter'].includes(initializer.getExpression().getText());

        if (isDirectHookCall) {
          const varName = decl.getName();
          // 원래 변수명 저장 (변경 전)
          navigateVariableNames.add(varName);
          
          // ✅ 변수명을 router로 변경 (router가 아닌 경우)
          if (varName !== 'router') {
            decl.getNameNode().replaceWithText('router');
            modified = true;
          }
        }
      }
    }
  }

  // ✅ 수정: navigate() 호출을 router.push() 또는 router.back()으로 변경 (명세 c.4, c.5)
  const allCallExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of allCallExpressions) {
    const expression = call.getExpression();
    const exprText = expression.getText();

    // navigate 변수명인 경우 (useNavigate() 또는 useRouter()로 초기화된 변수)
    // 또는 이미 router로 변경된 경우
    if (navigateVariableNames.has(exprText) || exprText === 'navigate') {
      const args = call.getArguments();
      if (args.length > 0) {
        const argText = args[0].getText();
        // ✅ 수정: navigate(-1) → router.back() (명세 c.5)
        if (argText === '-1' || argText === '-1n' || argText.match(/^-\s*1\s*$/)) {
          // router.back()으로 교체
          call.replaceWithText('router.back()');
          modified = true;
        } else {
          // ✅ 수정: navigate('/path') → router.push('/path') (명세 c.4)
          // 전체 호출을 router.push(...)로 교체
          const argsText = args.map(arg => arg.getText()).join(', ');
          call.replaceWithText(`router.push(${argsText})`);
          modified = true;
        }
      } else {
        // 인자가 없으면 router.push()로 변경 (기본값)
        call.replaceWithText('router.push()');
        modified = true;
      }
    }
  }

  // ✅ 추가: navigate 변수 참조를 router로 변경 (호출이 아닌 경우)
  const allIdentifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
  for (const identifier of allIdentifiers) {
    const identifierText = identifier.getText();
    
    // navigate 변수명이고, 원래 navigate 변수였던 경우
    if (identifierText === 'navigate') {
      const parent = identifier.getParent();
      // 호출 표현식이 아닌 경우만 변경 (호출은 이미 위에서 처리됨)
      if (parent && parent.getKind() !== SyntaxKind.CallExpression) {
        identifier.replaceWithText('router');
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

  // ✅ 수정: 실행 순서 중요
  // 0. styled(NavLink) 식별자 변환 먼저
  if (migrateStyledNavLinkReferences(sourceFile)) {
    modified = true;
  }

  // 1. NavLink 변환 먼저 (NavLink가 Link로 변환되므로)
  if (migrateNavLink(sourceFile)) {
    modified = true;
  }

  // 2. Link import 변환 (명세 a.1)
  if (migrateLinkImport(sourceFile)) {
    modified = true;
  }

  // 3. Link 태그 변환 (명세 a.2, a.3) - 모든 Link 태그의 to → href 변환
  if (migrateLinkTag(sourceFile)) {
    modified = true;
  }

  // 4. useNavigate 변환 (명세 c)
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
  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // ✅ 수정: 모든 .tsx, .ts, .jsx, .js 파일 찾기 (재귀적으로, 폴더 안에 있는 것도 포함)
  const files = [];
  const extensions = ['.tsx', '.ts', '.jsx', '.js'];
  const ignoreDirs = ['node_modules', '.next', 'dist', 'app']; // app 폴더는 제외 (생성된 파일)

  async function findFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(srcDir, fullPath);

      // 무시할 디렉토리 체크
      if (entry.isDirectory()) {
        if (!ignoreDirs.some((ignore) => relativePath.includes(ignore))) {
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

  for (const file of files) {
    try {
      await migrateFileLinks(file);
    } catch (error) {
      // 오류 시 무시
    }
  }
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
