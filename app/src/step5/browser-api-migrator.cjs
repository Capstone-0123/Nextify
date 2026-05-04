// src/step5/browser-api-migrator.cjs
// 브라우저 전용 API(window, document, localStorage) 최상단 접근 제어 모듈
// Next.js 14+ App Router, React 18 Strict Mode, Zustand 최적화

const { Project, SyntaxKind } = require('ts-morph');
const fs = require('fs-extra');
const path = require('path');
const { stopAndOfferGeminiApply } = require('../utils/manual-flow.cjs');

// ============================================================================
// Case 1: Variable Declaration - Utils/Constants (.ts, .tsx)
// ============================================================================

/**
 * Case 1: 변수 선언 시 브라우저 API 접근 처리
 * Store 파일은 제외하고, 스토어 생성 함수는 보호
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
function handleVariableDeclaration(projectRoot) {
  console.log('   📝 Case 1: Variable Declaration 처리 중...');
  
  const srcPath = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcPath)) {
    console.log('   ⚠️ src 디렉토리를 찾을 수 없습니다.');
    return;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  // .ts, .tsx 파일 찾기 (store 파일 제외)
  const allFiles = [
    ...findFiles(srcPath, /\.ts$/),
    ...findFiles(srcPath, /\.tsx$/),
  ];
  const files = allFiles.filter(filePath => {
    return !isStoreFile(filePath, srcPath);
  });
  
  let modifiedCount = 0;
  
  for (const filePath of files) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      let modified = false;

      // 최상단 변수 선언 찾기 (const, let)
      const statements = sourceFile.getStatements();
      const topLevelVariableStatements = [];
      
      for (const stmt of statements) {
        if (stmt.getKind() === SyntaxKind.VariableStatement) {
          // 부모가 함수나 클래스 내부가 아닌지 확인
          let isInsideFunction = false;
          let parent = stmt.getParent();
          while (parent) {
            const kind = parent.getKind();
            if (kind === SyntaxKind.FunctionDeclaration ||
                kind === SyntaxKind.FunctionExpression ||
                kind === SyntaxKind.ArrowFunction ||
                kind === SyntaxKind.ClassDeclaration ||
                kind === SyntaxKind.MethodDeclaration) {
              isInsideFunction = true;
              break;
            }
            parent = parent.getParent();
          }
          
          if (!isInsideFunction) {
            topLevelVariableStatements.push(stmt);
          }
        }
      }
      
      // 스토어/클라이언트 생성 함수 목록 (절대 fallback 하면 안 되는 함수들)
      const storeCreationFunctions = [
        'create',
        'configureStore',
        'QueryClient',
        'ApolloClient',
        'createStore',
        'createSlice',
      ];
      
      for (const varStatement of topLevelVariableStatements) {
        const declarations = varStatement.getDeclarationList().getDeclarations();
        
        for (const declaration of declarations) {
          const initializer = declaration.getInitializer();
          if (!initializer) continue;

          const initializerText = initializer.getText();
          
          // 이미 typeof window 체크가 있는지 확인 (idempotency)
          if (initializerText.includes('typeof window') || initializerText.includes('typeof document')) {
            continue;
          }
          
          // 스토어 생성 함수 호출인지 확인
          const isStoreCreation = storeCreationFunctions.some(func => {
            // create(...), configureStore(...), new QueryClient(...) 등
            const pattern1 = new RegExp(`\\b${func}\\s*[<(]`);
            const pattern2 = new RegExp(`new\\s+${func}\\s*[<(]`);
            return pattern1.test(initializerText) || pattern2.test(initializerText);
          });
          
          if (isStoreCreation) {
            // 스토어 생성 함수는 항상 실행되어야 함
            // 내부의 localStorage 접근만 처리
            const modifiedStore = processStoreCreation(initializer, sourceFile);
            if (modifiedStore) {
              modified = true;
              console.log(`      ✅ ${path.relative(projectRoot, filePath)}: 스토어 내부 localStorage 접근 처리됨: ${declaration.getName()}`);
            }
            continue;
          }
          
          // window, document, localStorage 직접 참조 확인
          const browserApiPatterns = [
            /(window|document|localStorage|sessionStorage)\.[\w.]+/,
            /window\.(innerWidth|innerHeight|outerWidth|outerHeight|screen|location|navigator|Swiper|Chart|Map|Editor)/,
            /document\.(body|documentElement|title|cookie|domain)/,
            /localStorage\.(getItem|setItem|removeItem|clear)/,
            /sessionStorage\.(getItem|setItem|removeItem|clear)/,
          ];
          
          const hasBrowserApi = browserApiPatterns.some(pattern => pattern.test(initializerText));
          if (!hasBrowserApi) continue;

          // 변수명 가져오기
          const varName = declaration.getName();
          
          // 이벤트 핸들러인지 확인 (handle로 시작하거나 함수를 할당하는 경우)
          const isEventHandler = /^handle/.test(varName) || 
                                 varName.toLowerCase().includes('handler') ||
                                 varName.toLowerCase().includes('submit') ||
                                 varName.toLowerCase().includes('click');
          
          // 이벤트 핸들러는 처리하지 않음 (일반 함수로 유지)
          if (isEventHandler) {
            continue;
          }
          
          // ========================================================================
          // 우선순위 1: 사용 그래프 분석 및 React 컴포넌트 내부 사용 확인
          // ========================================================================
          
          if (filePath.endsWith('.tsx')) {
            // React 컴포넌트 내부에서 사용되는지 확인
            const usageAnalysis = analyzeVariableUsage(sourceFile, varName);
            
            // useState 초기화자로 사용되는 경우 → Semantic React Migration (최우선)
            if (usageAnalysis.usedAsUseStateInitializer) {
              const migrationResult = performSemanticReactMigration(
                sourceFile,
                varName,
                initializerText,
                usageAnalysis.useStateInfo,
                varStatement
              );
              
              if (migrationResult.success) {
                modified = true;
                console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${varName} → Semantic React Migration 적용됨`);
                continue; // 다음 변수로 이동
              } else {
                // 마이그레이션 실패 시 변환 중단 (모호한 경우)
                console.warn(`      ⚠️ ${path.relative(projectRoot, filePath)}: ${varName} 마이그레이션 실패, 변환 중단`);
                continue;
              }
            }
            
            // JSX 또는 render logic에서 사용되는 경우 → Semantic Migration
            if (usageAnalysis.usedInJSX || usageAnalysis.usedInRenderLogic) {
              // 이미 Case 3에서 처리되므로 여기서는 스킵
              continue;
            }
            
            // Event handler에서 사용되는 경우 → 처리하지 않음
            if (usageAnalysis.usedInEventHandler) {
              continue;
            }
          }
          
          // localStorage/sessionStorage 읽기인 경우 추가 처리
          // (이미 위에서 semantic migration이 적용되었을 수 있음)
          const isStorageRead = /(localStorage|sessionStorage)\.getItem/.test(initializerText);
          
          // localStorage 읽기가 컴포넌트 state에 영향을 주는 경우 최상단에 남겨두지 않음
          if (isStorageRead && filePath.endsWith('.tsx')) {
            // 이미 semantic migration이 적용되었는지 확인
            // (위의 usageAnalysis에서 처리되었을 수 있음)
            // 여기서는 추가로 처리할 필요 없음
          }
          
          // ========================================================================
          // 우선순위 3: Generic typeof window 래핑 (최하위 우선순위)
          // React 컴포넌트와 연결되지 않은 경우에만 적용
          // ========================================================================
          
          // .tsx 파일인 경우 추가 검증
          if (filePath.endsWith('.tsx')) {
            const usageAnalysis = analyzeVariableUsage(sourceFile, varName);
            
            // React 컴포넌트와 연결된 경우 변환 중단
            if (usageAnalysis.usedAsUseStateInitializer ||
                usageAnalysis.usedInJSX ||
                usageAnalysis.usedInRenderLogic ||
                usageAnalysis.usedInEventHandler) {
              // 이미 semantic migration이 적용되었거나 Case 3에서 처리될 예정
              console.log(`      ⏭️ ${path.relative(projectRoot, filePath)}: ${varName} → React 컴포넌트와 연결됨, generic 래핑 스킵`);
              continue;
            }
          }
          
          // React 컴포넌트와 연결되지 않은 경우에만 generic typeof window 래핑 적용
          // 타입 추론 (기본값 결정)
          const type = inferTypeFromExpression(initializerText);
          const defaultValue = getDefaultValue(type);

          // 초기화식 교체
          let newInitializer;
          if (initializerText.includes('||')) {
            // window.Swiper || null 같은 패턴
            newInitializer = `typeof window !== 'undefined' ? (${initializerText}) : ${defaultValue}`;
          } else {
            newInitializer = `typeof window !== 'undefined' ? ${initializerText} : ${defaultValue}`;
          }
          
          initializer.replaceWithText(newInitializer);
          
          modified = true;
          console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${varName} → Generic typeof window 래핑 적용됨`);
        }
      }

      if (modified) {
        sourceFile.saveSync();
        modifiedCount++;
      }
    } catch (error) {
      console.warn(`   ⚠️ ${filePath} 처리 실패: ${error.message}`);
    }
  }

  console.log(`   ✅ Case 1 완료: ${modifiedCount}개 파일 수정됨`);
}

/**
 * 스토어 생성 함수 내부의 localStorage 접근 처리
 * create() 호출 자체는 항상 실행되도록 보호
 */
function processStoreCreation(initializer, sourceFile) {
  let modified = false;
  
  // 화살표 함수와 함수 표현식 찾기
  const arrowFunctions = initializer.getDescendantsOfKind(SyntaxKind.ArrowFunction);
  const functionExpressions = initializer.getDescendantsOfKind(SyntaxKind.FunctionExpression);
  
  const allFunctions = [...arrowFunctions, ...functionExpressions];
  
  for (const func of allFunctions) {
    const body = func.getBody();
    if (!body || body.getKind() !== SyntaxKind.Block) continue;
    
    // CallExpression 찾기
    const callExpressions = body.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    for (const expr of callExpressions) {
      const exprText = expr.getText();
      
      // localStorage 접근 확인
      if (/localStorage\.(getItem|setItem|removeItem|clear)/.test(exprText)) {
        // 이미 typeof window 체크가 있는지 확인
        let parent = expr.getParent();
        let alreadyProtected = false;
        while (parent) {
          const parentText = parent.getText();
          if (parentText.includes('typeof window')) {
            alreadyProtected = true;
            break;
          }
          parent = parent.getParent();
        }
        
        if (alreadyProtected) continue;
        
        try {
          // localStorage 호출만 감싸기
          const newExpr = `typeof window !== 'undefined' ? ${exprText} : null`;
          expr.replaceWithText(newExpr);
          modified = true;
        } catch (error) {
          // AST 교체 실패 시 텍스트 교체 시도
          const bodyText = body.getText();
          const escapedExpr = exprText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const newBodyText = bodyText.replace(
            new RegExp(`\\b${escapedExpr}\\b`, 'g'),
            `typeof window !== 'undefined' ? ${exprText} : null`
          );
          if (newBodyText !== bodyText) {
            body.replaceWithText(newBodyText);
            modified = true;
          }
        }
      }
    }
  }
  
  return modified;
}

// ============================================================================
// Case 2: Side Effect Logic - Utils/Logic (.ts) 즉시 실행 코드
// ============================================================================

/**
 * Case 2: .ts 파일에서 즉시 실행되는 브라우저 API 호출 처리
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
function handleSideEffectLogic(projectRoot) {
  console.log('   📝 Case 2: Side Effect Logic 처리 중...');
  
  const srcPath = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcPath)) {
    return;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  // .ts 파일만 찾기 (store 파일 제외)
  const allTsFiles = findFiles(srcPath, /\.ts$/);
  const tsFiles = allTsFiles.filter(filePath => {
    return !isStoreFile(filePath, srcPath);
  });
  
  let modifiedCount = 0;
  
  for (const filePath of tsFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      let modified = false;

      const statements = sourceFile.getStatements();
      
      for (const statement of statements) {
        if (statement.getKind() === SyntaxKind.ExpressionStatement) {
          const expr = statement.getExpression();
          const exprText = expr.getText();
          
          // 브라우저 API 호출 확인
          const browserApiCalls = [
            /window\.(addEventListener|removeEventListener|alert|confirm|prompt)/,
            /document\.(title|body|querySelector|getElementById)/,
            /document\.body\.(classList|style)/,
          ];

          const hasBrowserApiCall = browserApiCalls.some(pattern => pattern.test(exprText));
          
          if (!hasBrowserApiCall) continue;
          
          // 이미 typeof window 체크가 있는지 확인 (idempotency)
          let parent = statement.getParent();
          let alreadyProtected = false;
          while (parent) {
            const parentText = parent.getText();
            if (parentText.includes('typeof window')) {
              alreadyProtected = true;
              break;
            }
            parent = parent.getParent();
          }
          
          if (alreadyProtected) continue;

          // if (typeof window !== 'undefined') 블록으로 래핑
          const newCode = `if (typeof window !== 'undefined') {\n  ${exprText};\n}`;
          statement.replaceWithText(newCode);
          modified = true;
          console.log(`      ✅ ${path.relative(projectRoot, filePath)}: 실행 구문 래핑됨`);
        }
      }

      if (modified) {
        sourceFile.saveSync();
        modifiedCount++;
      }
    } catch (error) {
      console.warn(`   ⚠️ ${filePath} 처리 실패: ${error.message}`);
    }
  }

  console.log(`   ✅ Case 2 완료: ${modifiedCount}개 파일 수정됨`);
}

// ============================================================================
// Case 3: Rendering Value - Component (.tsx) 렌더링 값 계산
// ============================================================================

/**
 * Case 3: .tsx 파일에서 렌더링에 사용되는 브라우저 값 처리
 * Hydration-safe 패턴: mounted state 사용
 * typeof window는 렌더링에서 절대 사용하지 않음
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
function handleRenderingValue(projectRoot) {
  console.log('   📝 Case 3: Rendering Value 처리 중...');
  
  const srcPath = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcPath)) {
    return;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  const tsxFiles = findFiles(srcPath, /\.tsx$/);
  
  let modifiedCount = 0;
  
  for (const filePath of tsxFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      let modified = false;
      const fileText = sourceFile.getText();
      
      // 컴포넌트 함수 찾기
      const functions = sourceFile.getFunctions();
      
      for (const func of functions) {
        const body = func.getBody();
        if (!body || body.getKind() !== SyntaxKind.Block) continue;

        const statements = body.getStatements();
        
        // 이미 mounted 패턴이 있는지 확인 (idempotency)
        const hasMountedPattern = fileText.includes('const [mounted') && 
                                  fileText.includes('setMounted(true)');
        
        // 최상단 변수 선언에서 브라우저 API 사용 확인
        for (let i = 0; i < statements.length; i++) {
          const stmt = statements[i];
          
          if (stmt.getKind() === SyntaxKind.VariableStatement) {
            const declarations = stmt.getDeclarationList().getDeclarations();
            
            for (const declaration of declarations) {
              const initializer = declaration.getInitializer();
              if (!initializer) continue;

              const initializerText = initializer.getText();
              const varName = declaration.getName();
              
              // 이미 useState나 useEffect에 있는지 확인 (idempotency)
              if (initializerText.includes('useState') || initializerText.includes('useEffect')) {
                continue;
              }

              // typeof window 체크가 있는 경우 처리
              if (initializerText.includes('typeof window')) {
                // typeof window를 제거하고 원래 표현식 추출
                const cleanExpression = initializerText
                  .replace(/typeof\s+window\s*!==\s*['"]undefined['"]\s*\?\s*/, '')
                  .replace(/\s*:\s*[^,}]+$/, '')
                  .trim();
                
                if (cleanExpression && cleanExpression !== initializerText) {
                  // 브라우저 API 사용 확인
                  const browserApiPatterns = [
                    /(window|document|localStorage|sessionStorage)\.[\w.]+/,
                    /window\.(innerWidth|innerHeight|outerWidth|outerHeight|screen|location|navigator)/,
                    /document\.(body|documentElement|title|cookie|domain)/,
                  ];
                  
                  const hasBrowserApi = browserApiPatterns.some(pattern => pattern.test(cleanExpression));
                  
                  if (hasBrowserApi) {
                    // JSX에서 사용되는지 확인
                    const jsxUsage = findJsxUsage(sourceFile, varName);
                    if (jsxUsage) {
                      // localStorage인지 확인
                      const isLocalStorage = /localStorage\.(getItem|setItem)/.test(cleanExpression);
                      
                      // mounted 패턴이 필요한지 확인
                      const needsMountedPattern = requiresMountedPattern(cleanExpression);
                      
                      if (isLocalStorage) {
                        // localStorage는 항상 빈 문자열 기본값 + useEffect
                        const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
                        const newVarDecl = `const [${varName}, ${setterName}] = useState("");`;
                        const useEffectCode = `\nuseEffect(() => {\n  ${setterName}(${cleanExpression});\n}, []);`;
                        
                        stmt.replaceWithText(newVarDecl + useEffectCode);
                        addReactHookImports(sourceFile, ['useState', 'useEffect']);
                        
                        modified = true;
                        console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${varName} → localStorage useEffect 패턴으로 변환됨`);
                      } else if (needsMountedPattern) {
                        // mounted 패턴이 필요한 경우 (window.innerWidth, matchMedia, navigator 등)
                        const type = inferTypeFromExpression(cleanExpression);
                        const defaultValue = getDefaultValue(type);
                        const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
                        
                        let mountedCode = '';
                        if (!hasMountedPattern) {
                          mountedCode = `const [mounted, setMounted] = useState(false);\nuseEffect(() => setMounted(true), []);\n`;
                          addReactHookImports(sourceFile, ['useState', 'useEffect']);
                        }
                        
                        const newVarDecl = `${mountedCode}const [${varName}, ${setterName}] = useState(${defaultValue});`;
                        const useEffectCode = `\nuseEffect(() => {\n  ${setterName}(${cleanExpression});\n}, []);`;
                        
                        stmt.replaceWithText(newVarDecl + useEffectCode);
                        addReactHookImports(sourceFile, ['useState', 'useEffect']);
                        addMountedGuard(sourceFile, func);
                        
                        modified = true;
                        console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${varName} → Hydration-safe 패턴으로 변환됨`);
                      } else {
                        // 그 외의 경우 useEffect 사용
                        const type = inferTypeFromExpression(cleanExpression);
                        const defaultValue = getDefaultValue(type);
                        const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
                        
                        const newVarDecl = `const [${varName}, ${setterName}] = useState(${defaultValue});`;
                        const useEffectCode = `\nuseEffect(() => {\n  ${setterName}(${cleanExpression});\n}, []);`;
                        
                        stmt.replaceWithText(newVarDecl + useEffectCode);
                        addReactHookImports(sourceFile, ['useState', 'useEffect']);
                        
                        modified = true;
                        console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${varName} → useEffect 패턴으로 변환됨`);
                      }
                    }
                  }
                }
                continue;
              }
              
              // 브라우저 API 사용 확인
              const browserApiPatterns = [
                /(window|document|localStorage|sessionStorage)\.[\w.]+/,
                /window\.(innerWidth|innerHeight|outerWidth|outerHeight|screen|location|navigator)/,
                /document\.(body|documentElement|title|cookie|domain)/,
              ];
              
              const hasBrowserApi = browserApiPatterns.some(pattern => pattern.test(initializerText));
              if (!hasBrowserApi) continue;

              // 이벤트 핸들러인지 확인 (handle로 시작하거나 JSX props에 함수로 할당)
              const isEventHandler = /^handle/.test(varName) || 
                                     varName.toLowerCase().includes('handler') ||
                                     varName.toLowerCase().includes('submit') ||
                                     varName.toLowerCase().includes('click');
              
              // JSX에서 함수 prop으로 사용되는지 확인
              const jsxAttributes = sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute);
              let isFunctionProp = false;
              for (const attr of jsxAttributes) {
                const nameNode = attr.getNameNode();
                const attrName = nameNode ? nameNode.getText() : '';
                const attrValue = attr.getInitializer();
                if (attrName === varName || (attrValue && attrValue.getText().includes(varName))) {
                  // onSubmit, onClick 등 이벤트 핸들러 prop인지 확인
                  if (/^(on[A-Z]|onSubmit|onClick|onChange|onFocus|onBlur)/.test(attrName)) {
                    isFunctionProp = true;
                    break;
                  }
                }
              }
              
              // 이벤트 핸들러는 useState로 변환하지 않음
              if (isEventHandler || isFunctionProp) {
                continue;
              }

              // JSX에서 사용되는지 확인
              const jsxUsage = findJsxUsage(sourceFile, varName);
              if (!jsxUsage) continue;

              // localStorage인지 확인
              const isLocalStorage = /localStorage\.(getItem|setItem)/.test(initializerText);
              
              // mounted 패턴이 필요한지 확인 (window.innerWidth, matchMedia, navigator, layout measurement만)
              const needsMountedPattern = requiresMountedPattern(initializerText);
              
              if (isLocalStorage) {
                // localStorage는 항상 빈 문자열 기본값 + useEffect
                const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
                const newVarDecl = `const [${varName}, ${setterName}] = useState("");`;
                const useEffectCode = `\nuseEffect(() => {\n  ${setterName}(${initializerText});\n}, []);`;
                
                stmt.replaceWithText(newVarDecl + useEffectCode);
                addReactHookImports(sourceFile, ['useState', 'useEffect']);
                
                modified = true;
                console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${varName} → localStorage useEffect 패턴으로 변환됨`);
              } else if (needsMountedPattern) {
                // mounted 패턴이 필요한 경우 (window.innerWidth, matchMedia, navigator 등)
                const type = inferTypeFromExpression(initializerText);
                const defaultValue = getDefaultValue(type);
                const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
                
                let mountedCode = '';
                if (!hasMountedPattern) {
                  mountedCode = `const [mounted, setMounted] = useState(false);\nuseEffect(() => setMounted(true), []);\n`;
                  addReactHookImports(sourceFile, ['useState', 'useEffect']);
                }
                
                const newVarDecl = `${mountedCode}const [${varName}, ${setterName}] = useState(${defaultValue});`;
                const useEffectCode = `\nuseEffect(() => {\n  ${setterName}(${initializerText});\n}, []);`;
                
                stmt.replaceWithText(newVarDecl + useEffectCode);
                addReactHookImports(sourceFile, ['useState', 'useEffect']);
                addMountedGuard(sourceFile, func);
                
                modified = true;
                console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${varName} → Hydration-safe 패턴으로 변환됨`);
              } else {
                // 그 외의 경우 useEffect 사용
                const type = inferTypeFromExpression(initializerText);
                const defaultValue = getDefaultValue(type);
                const setterName = `set${varName.charAt(0).toUpperCase() + varName.slice(1)}`;
                
                const newVarDecl = `const [${varName}, ${setterName}] = useState(${defaultValue});`;
                const useEffectCode = `\nuseEffect(() => {\n  ${setterName}(${initializerText});\n}, []);`;
                
                stmt.replaceWithText(newVarDecl + useEffectCode);
                addReactHookImports(sourceFile, ['useState', 'useEffect']);
                
                modified = true;
                console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${varName} → useEffect 패턴으로 변환됨`);
              }
            }
          }
        }
      }

      if (modified) {
        sourceFile.saveSync();
        modifiedCount++;
      }
    } catch (error) {
      console.warn(`   ⚠️ ${filePath} 처리 실패: ${error.message}`);
    }
  }

  console.log(`   ✅ Case 3 완료: ${modifiedCount}개 파일 수정됨`);
}

/**
 * 컴포넌트에 mounted guard 추가
 */
function addMountedGuard(sourceFile, func) {
  const body = func.getBody();
  if (!body || body.getKind() !== SyntaxKind.Block) return;
  
  const statements = body.getStatements();
  const returnStmt = statements.find(s => s.getKind() === SyntaxKind.ReturnStatement);
  
  if (returnStmt) {
    const currentStatements = body.getStatements();
    const returnIndex = currentStatements.indexOf(returnStmt);
    
    if (returnIndex !== -1 && returnIndex > 0) {
      // 이미 guard가 있는지 확인 (idempotency)
      const prevStmt = currentStatements[returnIndex - 1];
      if (prevStmt.getKind() === SyntaxKind.IfStatement) {
        const ifText = prevStmt.getText();
        if (ifText.includes('!mounted') || ifText.includes('mounted === false')) {
          return; // 이미 guard가 있음
        }
      }
      
      // guard 추가
      body.insertStatements(returnIndex, writer => {
        writer.writeLine('if (!mounted) return null;');
      });
    }
  }
}

// ============================================================================
// Case 4: DOM/Event Handler - Component (.tsx) 렌더링 외 실행
// ============================================================================

/**
 * Case 4: .tsx 파일에서 렌더링 외 브라우저 API 실행 처리
 * DOM 접근과 이벤트 리스너를 useEffect로 이동
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
function handleDOMEventHandler(projectRoot) {
  console.log('   📝 Case 4: DOM/Event Handler 처리 중...');
  
  const srcPath = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcPath)) {
    return;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  const tsxFiles = findFiles(srcPath, /\.tsx$/);
  
  let modifiedCount = 0;
  
  for (const filePath of tsxFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      let modified = false;

      // 컴포넌트 함수 찾기
      const functions = sourceFile.getFunctions();
      
      for (const func of functions) {
        const body = func.getBody();
        if (!body || body.getKind() !== SyntaxKind.Block) continue;

        const statements = body.getStatements();
        const statementsToMove = [];
        
        // 렌더링 단계에서 실행되는 브라우저 API 호출 찾기
        for (let i = 0; i < statements.length; i++) {
          const stmt = statements[i];
          
          if (stmt.getKind() === SyntaxKind.ExpressionStatement) {
            const expr = stmt.getExpression();
            const exprText = expr.getText();
            
            // DOM API 호출 확인
            const domApiPatterns = [
              /window\.(addEventListener|removeEventListener)/,
              /document\.(title|body|querySelector|getElementById|addEventListener|removeEventListener)/,
              /document\.body\.(classList|style)/,
            ];

            const hasDomApiCall = domApiPatterns.some(pattern => pattern.test(exprText));
            
            if (!hasDomApiCall) continue;
            
            // 이미 useEffect 내부에 있는지 확인
            let isInsideUseEffect = false;
            let currentParent = stmt.getParent();
            while (currentParent) {
              const kind = currentParent.getKind();
              if (kind === SyntaxKind.CallExpression) {
                const callExpr = currentParent.getExpression();
                if (callExpr && callExpr.getText() === 'useEffect') {
                  isInsideUseEffect = true;
                  break;
                }
              }
              currentParent = currentParent.getParent();
            }
            
            if (isInsideUseEffect) continue;

            statementsToMove.push({ stmt, exprText });
          }
        }

        // useEffect로 이동
        if (statementsToMove.length > 0) {
          // return 문을 먼저 찾기 (변경 전)
          const returnStmt = statements.find(s => 
            s.getKind() === SyntaxKind.ReturnStatement
          );
          
          let useEffectCode = '\nuseEffect(() => {\n';
          let hasAddEventListener = false;
          let eventHandlers = [];
          
          // 코드 생성
          for (const { exprText } of statementsToMove) {
            if (exprText.includes('addEventListener')) {
              // window.addEventListener('scroll', handler) 또는 document.addEventListener('click', handler)
              const match = exprText.match(/(window|document)\.addEventListener\(['"]([\w]+)['"],\s*([^)]+)\)/);
              if (match) {
                const [, target, eventType, handler] = match;
                useEffectCode += `  ${exprText};\n`;
                eventHandlers.push({ target, eventType, handler: handler.trim() });
                hasAddEventListener = true;
              } else {
                useEffectCode += `  ${exprText};\n`;
              }
            } else {
              useEffectCode += `  ${exprText};\n`;
            }
          }
          
          // cleanup 함수 추가
          if (hasAddEventListener && eventHandlers.length > 0) {
            useEffectCode += '  return () => {\n';
            for (const { target, eventType, handler } of eventHandlers) {
              useEffectCode += `    ${target}.removeEventListener('${eventType}', ${handler});\n`;
            }
            useEffectCode += '  };\n';
          }
          
          useEffectCode += '}, []);';
          
          // statements 제거 (역순으로)
          for (let i = statementsToMove.length - 1; i >= 0; i--) {
            statementsToMove[i].stmt.remove();
          }
          
          // useEffect 추가
          if (returnStmt) {
            // returnStmt의 현재 위치 찾기 (제거 후)
            const currentStatements = body.getStatements();
            const returnIndex = currentStatements.indexOf(returnStmt);
            if (returnIndex !== -1) {
              body.insertStatements(returnIndex, writer => {
                writer.writeLine(useEffectCode);
              });
            } else {
              body.addStatements(useEffectCode);
            }
          } else {
            body.addStatements(useEffectCode);
          }
          
          // useEffect import 추가 (중복 방지)
          addReactHookImports(sourceFile, ['useEffect']);
          
          modified = true;
          console.log(`      ✅ ${path.relative(projectRoot, filePath)}: DOM API 호출 → useEffect로 이동됨`);
        }
      }

      if (modified) {
        sourceFile.saveSync();
        modifiedCount++;
      }
    } catch (error) {
      console.warn(`   ⚠️ ${filePath} 처리 실패: ${error.message}`);
    }
  }

  console.log(`   ✅ Case 4 완료: ${modifiedCount}개 파일 수정됨`);
}

// ============================================================================
// Case 5: Void/Reference - 무의미한 코드 제거
// ============================================================================

/**
 * Case 5: 무의미한 브라우저 API 참조 코드 제거
 * void (window.innerWidth < 768), void window.innerWidth 등
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
function handleVoidReference(projectRoot) {
  console.log('   📝 Case 5: Void/Reference 처리 중...');
  
  const srcPath = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcPath)) {
    return;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  const allFiles = [
    ...findFiles(srcPath, /\.ts$/),
    ...findFiles(srcPath, /\.tsx$/),
  ];
  
  let removedCount = 0;
  
  for (const filePath of allFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      let modified = false;

      const statements = sourceFile.getStatements();
      const statementsToRemove = [];
      
      for (const stmt of statements) {
        if (stmt.getKind() === SyntaxKind.ExpressionStatement) {
          const expr = stmt.getExpression();
          const exprText = expr.getText();
          
          // void window, void (window.innerWidth < 768), window.console.log 등 무의미한 코드 패턴
          const voidPatterns = [
            /^void\s*\(?\s*(window|document|localStorage)/,
            /^void\s*\(?\s*window\./,
            /^void\s*\(?\s*\(window\.[^)]+\)/,
            /window\.console\.(log|warn|error|debug)/,
            /^(window|document|localStorage)\.\w+;?\s*$/,
          ];

          const isVoidReference = voidPatterns.some(pattern => pattern.test(exprText));
          
          if (isVoidReference) {
            // 변수 선언 내부가 아닌지 확인
            let parent = stmt.getParent();
            let isInsideVariable = false;
            while (parent) {
              if (parent.getKind() === SyntaxKind.VariableStatement) {
                isInsideVariable = true;
                break;
              }
              parent = parent.getParent();
            }
            
            if (!isInsideVariable) {
              statementsToRemove.push(stmt);
            }
          }
        }
      }

      // 코드 제거
      for (const stmt of statementsToRemove) {
        stmt.remove();
        modified = true;
        removedCount++;
      }

      if (modified) {
        sourceFile.saveSync();
        console.log(`      ✅ ${path.relative(projectRoot, filePath)}: 무의미한 코드 제거됨`);
      }
    } catch (error) {
      console.warn(`   ⚠️ ${filePath} 처리 실패: ${error.message}`);
    }
  }

  console.log(`   ✅ Case 5 완료: ${removedCount}개 코드 제거됨`);
}

// ============================================================================
// Case 6: Lib Initialization - UI 라이브러리 초기화
// ============================================================================

/**
 * Case 6: UI 라이브러리 초기화 처리
 * Dynamic Import로 강제 변환 (.tsx)
 * typeof window 체크 추가 (.ts)
 * 'use client'는 삽입하지 않음 (사용자 요청)
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
function handleLibInitialization(projectRoot) {
  console.log('   📝 Case 6: Lib Initialization 처리 중...');
  
  const srcPath = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcPath)) {
    return;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });

  const allFiles = [
    ...findFiles(srcPath, /\.ts$/),
    ...findFiles(srcPath, /\.tsx$/),
  ];
  
  const windowDependentLibs = [
    'Swiper',
    'Map',
    'Chart',
    'Editor',
    'ApexCharts',
    'Chart.js',
    'GoogleMap',
    'KakaoMap',
    'NaverMap',
    'TuiEditor',
    'Quill',
    'TinyMCE',
    'CKEditor',
    'CodeMirror',
    'Monaco',
    'D3',
    'Three',
    'Fabric',
    'Konva',
    'Pixi',
  ];
  
  let modifiedCount = 0;
  
  for (const filePath of allFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      let modified = false;
      const fileText = sourceFile.getText();

      // import 문에서 라이브러리 확인
      const imports = sourceFile.getImportDeclarations();
      let hasWindowDependentLib = false;
      let libName = null;
      let libImportPath = null;
      let importDeclToRemove = null;
      
      for (const importDecl of imports) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        const namedImports = importDecl.getNamedImports().map(n => n.getName());
        const defaultImport = importDecl.getDefaultImport()?.getText();
        
        for (const lib of windowDependentLibs) {
          if (moduleSpecifier.includes(lib.toLowerCase()) || 
              namedImports.includes(lib) || 
              defaultImport === lib) {
            hasWindowDependentLib = true;
            libName = lib;
            libImportPath = moduleSpecifier;
            importDeclToRemove = importDecl;
            break;
          }
        }
        
        if (hasWindowDependentLib) break;
      }

      if (!hasWindowDependentLib) continue;

      // 이미 useEffect나 dynamic import에 있는지 확인 (idempotency)
      if (fileText.includes('dynamic') || fileText.includes('useEffect')) {
        // dynamic import가 이미 있는지 확인
        const hasDynamicImport = fileText.includes(`dynamic(() => import('${libImportPath}')`);
        if (hasDynamicImport) {
          continue;
        }
      }

      // new 키워드로 인스턴스 생성 확인 (최상단)
      const statements = sourceFile.getStatements();
      
      for (const stmt of statements) {
        if (stmt.getKind() === SyntaxKind.VariableStatement) {
          const declarations = stmt.getDeclarationList().getDeclarations();
          
          for (const declaration of declarations) {
            const initializer = declaration.getInitializer();
            if (!initializer) continue;

            const initializerText = initializer.getText();
            
            // new LibName(...) 패턴 확인
            const newPattern = new RegExp(`new\\s+${libName}\\s*\\(`);
            if (!newPattern.test(initializerText)) continue;
            
            // 이미 useEffect나 dynamic import에 있는지 확인 (idempotency)
            if (initializerText.includes('useEffect') || 
                initializerText.includes('dynamic')) {
              continue;
            }

            // .tsx 파일인 경우 Dynamic Import로 강제 변환
            if (filePath.endsWith('.tsx')) {
              const varName = declaration.getName();
              
              // 기존 import 제거
              if (importDeclToRemove) {
                importDeclToRemove.remove();
                modified = true;
              }
              
              // dynamic import 추가
              const dynamicImportCode = `const ${varName} = dynamic(() => import('${libImportPath}'), { ssr: false });`;
              
              // import 문 다음에 추가
              const importStatements = sourceFile.getStatements().filter(s => 
                s.getKind() === SyntaxKind.ImportDeclaration
              );
              
              if (importStatements.length > 0) {
                const lastImport = importStatements[importStatements.length - 1];
                const lastImportIndex = sourceFile.getStatements().indexOf(lastImport);
                sourceFile.insertStatements(lastImportIndex + 1, dynamicImportCode);
              } else {
                sourceFile.insertStatements(0, dynamicImportCode);
              }
              
              // next/dynamic import 추가 (중복 방지)
              const hasDynamicImport = sourceFile.getImportDeclarations().some(
                decl => decl.getModuleSpecifierValue() === 'next/dynamic'
              );
              
              if (!hasDynamicImport) {
                sourceFile.addImportDeclaration({
                  defaultImport: 'dynamic',
                  moduleSpecifier: 'next/dynamic',
                });
                modified = true;
              }
              
              // 최상단 new Lib() 호출 제거
              stmt.remove();
              
              modified = true;
              console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${libName} → dynamic import로 변환됨`);
            } else {
              // .ts 파일인 경우 typeof window 체크 추가
              if (!initializerText.includes('typeof window')) {
                const newInitializer = `typeof window !== 'undefined' ? ${initializerText} : null`;
                initializer.replaceWithText(newInitializer);
                modified = true;
                console.log(`      ✅ ${path.relative(projectRoot, filePath)}: ${libName} 초기화에 typeof window 체크 추가됨`);
              }
            }
          }
        }
      }

      if (modified) {
        sourceFile.saveSync();
        modifiedCount++;
      }
    } catch (error) {
      console.warn(`   ⚠️ ${filePath} 처리 실패: ${error.message}`);
    }
  }

  console.log(`   ✅ Case 6 완료: ${modifiedCount}개 파일 수정됨`);
}

// ============================================================================
// 유틸리티 함수
// ============================================================================

/**
 * Store 파일인지 확인
 */
function isStoreFile(filePath, srcPath) {
  const relativePath = path.relative(srcPath, filePath);
  return relativePath.includes('store/') || 
         relativePath.includes('stores/') ||
         /\.store\.ts$/.test(filePath) ||
         /authStore\.ts$/.test(filePath) ||
         /.*Store\.ts$/.test(filePath);
}

/**
 * 파일에 'use client' 지시어가 있는지 확인
 */
function hasUseClient(sourceFile) {
  const statements = sourceFile.getStatements();
  for (const stmt of statements) {
    if (stmt.getKind() === SyntaxKind.ExpressionStatement) {
      const expr = stmt.getExpression();
      const exprText = expr.getText();
      if (exprText === "'use client'" || exprText === '"use client"') {
        return true;
      }
    }
  }
  return false;
}

/**
 * mounted 패턴이 필요한 브라우저 API인지 확인
 * (window.innerWidth, matchMedia, navigator, layout measurement만)
 */
function requiresMountedPattern(expression) {
  const mountedOnlyPatterns = [
    /window\.innerWidth/,
    /window\.innerHeight/,
    /window\.outerWidth/,
    /window\.outerHeight/,
    /window\.matchMedia/,
    /matchMedia/,
    /navigator\./,
    /window\.screen/,
    /getBoundingClientRect/,
    /getComputedStyle/,
    /offsetWidth/,
    /offsetHeight/,
    /clientWidth/,
    /clientHeight/,
  ];
  
  return mountedOnlyPatterns.some(pattern => pattern.test(expression));
}

/**
 * 변수 사용 그래프 분석
 * React 컴포넌트 내부에서 변수가 어떻게 사용되는지 분석
 */
function analyzeVariableUsage(sourceFile, varName) {
  const result = {
    usedAsUseStateInitializer: false,
    usedInJSX: false,
    usedInRenderLogic: false,
    usedInEventHandler: false,
    useStateInfo: null,
  };
  
  const functions = sourceFile.getFunctions();
  
  for (const func of functions) {
    const body = func.getBody();
    if (!body || body.getKind() !== SyntaxKind.Block) continue;
    
    const statements = body.getStatements();
    
    // useState 초기화자로 사용되는지 확인
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      if (stmt.getKind() === SyntaxKind.VariableStatement) {
        const declarations = stmt.getDeclarationList().getDeclarations();
        
        for (const decl of declarations) {
          const init = decl.getInitializer();
          if (!init) continue;
          
          // useState 호출인지 확인
          if (init.getKind() === SyntaxKind.CallExpression) {
            const callExpr = init;
            const expr = callExpr.getExpression();
            if (expr.getText() === 'useState') {
              // useState의 인자 확인
              const args = callExpr.getArguments();
              for (const arg of args) {
                const argText = arg.getText();
                
                // useState 인자에서 변수명이 사용되는지 확인
                // 1. 정확히 변수명과 일치하는 경우: useState(lastEmail)
                // 2. 변수명이 포함된 경우: useState(lastEmail || '')
                // 3. Identifier 노드로 직접 확인
                let isVarUsed = false;
                
                // Identifier 노드로 직접 확인 (가장 정확)
                const identifiers = arg.getDescendantsOfKind(SyntaxKind.Identifier);
                for (const identifier of identifiers) {
                  if (identifier.getText() === varName) {
                    isVarUsed = true;
                    break;
                  }
                }
                
                // 텍스트 매칭도 확인 (fallback)
                if (!isVarUsed) {
                  // 정확히 일치하거나 변수명이 포함된 경우
                  // 단, 다른 변수명의 일부가 아닌지 확인 (예: myLastEmail !== lastEmail)
                  const regex = new RegExp(`\\b${varName}\\b`);
                  if (regex.test(argText)) {
                    isVarUsed = true;
                  }
                }
                
                if (isVarUsed) {
                  result.usedAsUseStateInitializer = true;
                  const stateVarName = decl.getName();
                  
                  // 배열 구조 분해에서 setter 추출
                  let setterName = null;
                  const nameNode = decl.getNameNode();
                  if (nameNode.getKind() === SyntaxKind.ArrayBindingPattern) {
                    const elements = nameNode.getElements();
                    if (elements.length >= 2) {
                      const secondElement = elements[1];
                      if (secondElement.getKind() === SyntaxKind.BindingElement) {
                        const setterNode = secondElement.getNameNode();
                        if (setterNode.getKind() === SyntaxKind.Identifier) {
                          setterName = setterNode.getText();
                        }
                      }
                    }
                  }
                  
                  result.useStateInfo = {
                    func,
                    useStateStmt: stmt,
                    useStateIndex: i,
                    stateVarName,
                    declaration: decl,
                    initializer: init,
                    useStateArg: arg,
                    setterName: setterName || `set${stateVarName.charAt(0).toUpperCase() + stateVarName.slice(1)}`
                  };
                  break;
                }
              }
              if (result.usedAsUseStateInitializer) break;
            }
          }
        }
        if (result.usedAsUseStateInitializer) break;
      }
    }
    
    // JSX에서 사용되는지 확인
    if (findJsxUsage(sourceFile, varName)) {
      result.usedInJSX = true;
    }
    
    // Render logic에서 사용되는지 확인 (return 문 이전의 계산)
    const returnStmt = statements.find(s => s.getKind() === SyntaxKind.ReturnStatement);
    if (returnStmt) {
      const returnIndex = statements.indexOf(returnStmt);
      for (let i = 0; i < returnIndex; i++) {
        const stmt = statements[i];
        const identifiers = stmt.getDescendantsOfKind(SyntaxKind.Identifier);
        for (const identifier of identifiers) {
          if (identifier.getText() === varName) {
            result.usedInRenderLogic = true;
            break;
          }
        }
        if (result.usedInRenderLogic) break;
      }
    }
    
    // Event handler에서 사용되는지 확인
    const jsxAttributes = sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute);
    for (const attr of jsxAttributes) {
      const nameNode = attr.getNameNode();
      const attrName = nameNode ? nameNode.getText() : '';
      const attrValue = attr.getInitializer();
      if (attrValue && attrValue.getText().includes(varName)) {
        if (/^(on[A-Z]|onSubmit|onClick|onChange|onFocus|onBlur)/.test(attrName)) {
          result.usedInEventHandler = true;
          break;
        }
      }
    }
    
    if (result.usedAsUseStateInitializer || result.usedInJSX || result.usedInRenderLogic || result.usedInEventHandler) {
      break;
    }
  }
  
  return result;
}

/**
 * Semantic React Migration 수행
 * useState 초기화자로 사용되는 변수를 컴포넌트 내부로 마이그레이션
 */
function performSemanticReactMigration(sourceFile, varName, initializerText, useStateInfo, topLevelVarStatement) {
  try {
    const { func, useStateStmt, useStateIndex, stateVarName, declaration, initializer, useStateArg, setterName } = useStateInfo;
    const body = func.getBody();
    
    if (!body || body.getKind() !== SyntaxKind.Block) {
      return { success: false, reason: 'Invalid function body' };
    }
    
    // setter 이름 검증
    if (!setterName || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(setterName)) {
      return { success: false, reason: 'Invalid setter name' };
    }
    
    // useState 인자를 결정론적 기본값으로 교체
    const argText = useStateArg.getText();
    let newArgText = argText;
    
    // localStorage/sessionStorage 읽기인 경우 빈 문자열 사용
    if (/(localStorage|sessionStorage)\.getItem/.test(initializerText)) {
      // 정확히 변수명과 일치하거나 변수명이 포함된 경우
      const varRegex = new RegExp(`\\b${varName}\\b`);
      if (argText === varName) {
        newArgText = '""';
      } else if (varRegex.test(argText)) {
        // lastEmail || '' 같은 패턴 처리
        newArgText = argText.replace(
          new RegExp(`\\b${varName}(\\s*\\|\\|\\s*['"][^'"]*['"])?`, 'g'),
          '""'
        );
      }
    } else {
      // 다른 브라우저 API의 경우 타입에 맞는 기본값 사용
      const type = inferTypeFromExpression(initializerText);
      const defaultValue = getDefaultValue(type);
      const varRegex = new RegExp(`\\b${varName}\\b`);
      if (argText === varName) {
        newArgText = defaultValue;
      } else if (varRegex.test(argText)) {
        newArgText = argText.replace(
          new RegExp(`\\b${varName}(\\s*\\|\\|\\s*[^,}]+)?`, 'g'),
          defaultValue
        );
      }
    }
    
    useStateArg.replaceWithText(newArgText);
    
    // useEffect 추가하여 브라우저 API 읽기
    const useEffectCode = `useEffect(() => {\n  ${setterName}(${initializerText});\n}, []);`;
    
    body.insertStatements(useStateIndex + 1, writer => {
      writer.writeLine(useEffectCode);
    });
    
    addReactHookImports(sourceFile, ['useState', 'useEffect']);
    
    // 원래 최상단 선언 제거 (마이그레이션 후)
    topLevelVarStatement.remove();
    
    return { success: true };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

/**
 * 파일 찾기 (재귀)
 */
function findFiles(dir, pattern, excludePatterns = []) {
  const files = [];
  
  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.name === 'node_modules' || 
        entry.name === '.next' || 
        entry.name === 'dist' ||
        entry.name === 'build') {
      continue;
    }
    
    if (entry.isDirectory()) {
      files.push(...findFiles(fullPath, pattern, excludePatterns));
    } else if (entry.isFile()) {
      if (pattern.test(entry.name)) {
        const shouldExclude = excludePatterns.some(excludePattern => {
          if (typeof excludePattern === 'string') {
            return entry.name.endsWith(excludePattern);
          }
          return excludePattern.test(entry.name);
        });
        
        if (!shouldExclude) {
          files.push(fullPath);
        }
      }
    }
  }
  
  return files;
}

/**
 * 표현식에서 타입 추론
 */
function inferTypeFromExpression(expr) {
  const exprStr = String(expr);
  
  // 숫자 타입
  if (/\d+/.test(exprStr) || 
      exprStr.includes('innerWidth') || 
      exprStr.includes('innerHeight') || 
      exprStr.includes('outerWidth') || 
      exprStr.includes('outerHeight') || 
      exprStr.includes('scrollY') ||
      exprStr.includes('scrollX')) {
    return 'number';
  }
  
  // 불린 타입 (비교 연산자 포함)
  if (exprStr.includes('<') || exprStr.includes('>') || exprStr.includes('===') || 
      exprStr.includes('!==') || exprStr.includes('&&') || exprStr.includes('||')) {
    if (/window\.(innerWidth|innerHeight|outerWidth|outerHeight)/.test(exprStr) && 
        (exprStr.includes('<') || exprStr.includes('>'))) {
      return 'boolean';
    }
  }
  
  // 스토리지 타입
  if (exprStr.includes('getItem') || exprStr.includes('setItem') || 
      exprStr.includes('localStorage') || exprStr.includes('sessionStorage')) {
    return 'storage';
  }
  
  // DOM 요소 타입
  if (exprStr.includes('querySelector') || exprStr.includes('getElementById') || 
      exprStr.includes('getElementsBy')) {
    return 'element';
  }
  
  // 객체 타입
  if (exprStr.includes('|| null') || exprStr.includes('|| undefined') ||
      exprStr.includes('window.Swiper') || exprStr.includes('window.Chart') ||
      exprStr.includes('window.Map') || exprStr.includes('window.Editor')) {
    return 'null';
  }
  
  // 불린 타입 (명시적)
  if (exprStr.includes('true') || exprStr.includes('false')) {
    return 'boolean';
  }
  
  return 'string';
}

/**
 * 타입에 따른 기본값 반환
 */
function getDefaultValue(type) {
  switch (type) {
    case 'number':
      return '0';
    case 'storage':
      return 'null';
    case 'element':
      return 'null';
    case 'null':
      return 'null';
    case 'boolean':
      return 'false';
    case 'object':
      return 'null';
    case 'string':
    default:
      return '""';
  }
}

/**
 * JSX에서 변수 사용 여부 확인
 */
function findJsxUsage(sourceFile, varName) {
  const jsxElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement);
  const jsxExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.JsxExpression);
  const jsxAttributes = sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute);
  
  const allJsx = [...jsxElements, ...jsxExpressions, ...jsxAttributes];
  
  return allJsx.some(jsx => {
    const text = jsx.getText();
    return new RegExp(`\\b${varName}\\b`).test(text);
  });
}

/**
 * React Hook import 추가 (중복 방지)
 */
function addReactHookImports(sourceFile, hooks) {
  const reactImport = sourceFile.getImportDeclaration(
    decl => decl.getModuleSpecifierValue() === 'react'
  );

  if (reactImport) {
    const namedImports = reactImport.getNamedImports();
    const existingHooks = namedImports.map(n => n.getName());
    
    for (const hook of hooks) {
      if (!existingHooks.includes(hook)) {
        reactImport.addNamedImport(hook);
      }
    }
  } else {
    sourceFile.addImportDeclaration({
      namedImports: hooks,
      moduleSpecifier: 'react',
    });
  }
}

// ============================================================================
// 메인 실행 함수
// ============================================================================

/**
 * 브라우저 전용 API 최상단 접근 제어 실행
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
async function migrateBrowserAPIs(projectRoot) {
  const srcPath = path.join(projectRoot, 'src');

  if (!fs.existsSync(srcPath)) {
    return;
  }

  // 브라우저 전용 API 후보(문자열 기반)를 먼저 수집
  const browserApiRegexes = [
    /(window|document|localStorage|sessionStorage)\.[\w.]+/,
    /window\.(innerWidth|innerHeight|outerWidth|outerHeight|screen|location|navigator|Swiper|Chart|Map|Editor)\b/,
    /document\.(body|documentElement|title|cookie|domain)\b/,
    /localStorage\.(getItem|setItem|removeItem|clear)\b/,
    /sessionStorage\.(getItem|setItem|removeItem|clear)\b/,
    /window\.(addEventListener|removeEventListener|alert|confirm|prompt)\b/,
    /document\.(title|body|querySelector|getElementById)\b/,
    /document\.body\.(classList|style)\b/,
    /\bmatchMedia\(/,
    /\bgetBoundingClientRect\(/,
    /\bgetComputedStyle\(/,
  ];

  const allTsFiles = [
    ...findFiles(srcPath, /\.ts$/),
    ...findFiles(srcPath, /\.tsx$/),
  ];

  const candidateRelPaths = new Set();
  const maxFiles = 220; // step1과 비슷한 토큰 방어용 상한

  for (const absFilePath of allTsFiles) {
    if (candidateRelPaths.size >= maxFiles) break;
    if (isStoreFile(absFilePath, srcPath)) continue;

    let content = '';
    try {
      content = await fs.readFile(absFilePath, 'utf-8');
    } catch {
      continue;
    }

    const hasBrowserApi = browserApiRegexes.some((re) => re.test(content));
    if (!hasBrowserApi) continue;

    const rel = path.relative(projectRoot, absFilePath).split(path.sep).join('/');
    candidateRelPaths.add(rel);
  }

  if (candidateRelPaths.size === 0) {
    return;
  }

  const candidateRelPathsArr = Array.from(candidateRelPaths);

  await stopAndOfferGeminiApply({
    projectRoot,
    discoveryLine: `브라우저 전용 API(window/document/localStorage 등) 사용 코드가 ${candidateRelPathsArr.length}개 파일에서 감지되었습니다.`,
    discoverySources: candidateRelPathsArr,
    instructionForAi: `다음 파일들에서 브라우저 전용 API 접근이 서버 렌더/Next.js App Router 환경에서 깨질 수 있는 부분을 찾아서 수정하세요.

[작업 범위(매우 중요)]
이 작업의 유일한 목적은 브라우저 전용 API(window/document/localStorage/sessionStorage/navigator/location/history/matchMedia/IntersectionObserver/ResizeObserver/MutationObserver/requestAnimationFrame 등)가 서버 렌더 시 ReferenceError를 일으키지 않도록 보호하는 것입니다.
파일에 있는 다른 코드(특히 React hook과 그 import)는 절대 변경/삭제하지 마세요.

[절대 변경 금지(엄수)]
다음 항목은 한 글자도 추가/삭제/수정하지 마세요. 의심스러우면 그 파일을 원본 그대로 반환하세요.
- import 문 — 특히 'react'에서 가져오는 hook들(useState, useEffect, useLayoutEffect, useInsertionEffect, useRef, useMemo, useCallback, useReducer, useContext, useImperativeHandle, useSyncExternalStore, useTransition, useDeferredValue, useId 등)은 사용 중인 한 절대 제거 금지
- 'next/navigation', 'next/router'에서 가져오는 hook import (useRouter, useSearchParams, usePathname 등)
- 사용 중인 모든 hook 호출
- 사용자 정의 hook(use로 시작하는 함수)
- 함수/컴포넌트의 시그니처, props, 타입, 인터페이스
- JSX 구조, JSX 안의 이벤트 핸들러(onClick 등)
- 데이터 패칭 코드, 비즈니스 로직, 상태 관리 호출(zustand의 create 등)
- 주석, 빈 줄, 들여쓰기, 따옴표 종류

[허용되는 변경(이것만 가능)]
1) 모듈 스코프(파일 최상단, 함수/컴포넌트 바깥)에서 브라우저 API를 직접 참조하는 코드만 다음 중 하나로 처리:
   - 가능하면 그 파일에 이미 정의된 컴포넌트/함수 안으로 이동
   - 또는 \`typeof window !== 'undefined'\` (또는 typeof document/navigator) 가드로 감싸고, 서버에서는 안전한 기본값 사용
2) 렌더 본문(JSX 직전)에서 직접 브라우저 API를 참조하는 코드는 useEffect 안으로 이동하고 useState로 hydration-safe한 기본값 유지
   - 새 useState/useEffect를 추가할 때만 'react' import에 해당 hook을 추가 (이미 import되어 있다면 추가하지 말고 그대로 유지)
3) DOM 이벤트 등록/해제(addEventListener/removeEventListener)는 useEffect 안에서 수행하고 cleanup return을 추가
4) localStorage/sessionStorage 읽기/쓰기는 \`typeof window !== 'undefined'\` 또는 useEffect 안으로 이동
5) 위 변경으로 클라이언트 실행이 필요해진 파일에만 최상단에 'use client' 한 줄 추가 (이미 있으면 추가하지 말 것)

[코드 조각마다 단 하나의 전략만 — 매우 중요]
하나의 브라우저-API 사용 코드 조각에는 아래 두 전략 중 정확히 한 가지만 적용하세요. 두 전략을 동시에 적용하면 dead code가 생겨 TypeScript \`noUnusedLocals\` 빌드 에러("declared but its value is never read")가 발생합니다.

(A) 가드 전략(Guard-in-place):
- 모듈 스코프의 변수/표현식을 그 자리에 \`typeof window !== 'undefined' ? ... : 기본값\` 으로 감싸기만 함.
- 변수 이름/위치/사용처는 모두 그대로.
- useEffect/useState로 옮기지 마세요.

(B) 이동 전략(Move-into-component):
- 모듈 스코프의 변수를 컴포넌트 내부 useState로 바꾸고, 실제 값은 useEffect에서 설정.
- 이 경우 모듈 스코프에 있던 원본 \`let/const\` 선언과 그 주변의 \`if (typeof window ...)\` 블록을 **반드시 완전히 삭제**하세요.
- 부분 삭제(선언만 남기기, 가드 블록만 남기기)는 절대 금지.

같은 변수에 (A)와 (B)를 동시에 적용하지 마세요. 둘 다 했다가 한쪽 잔재를 남기는 실수가 가장 흔하므로 출력 직전 반드시 점검하세요.

[Dead code 절대 금지 — TS noUnusedLocals 대응]
- 수정 결과 파일의 모든 모듈-스코프 \`let\`/\`const\`/\`var\` 선언은 파일 어딘가에서 최소 1회 이상 참조되어야 합니다.
- 어떤 변수든 어떤 식별자든 선언만 하고 안 쓰면 빌드가 깨집니다(예: \`let initialScrollY = 0;\`만 남고 사용처가 useEffect로 옮겨져서 모듈 스코프에서 안 쓰이는 경우).
- "혹시 나중에 쓸 수 있으니 남겨두자" 식의 보존도 금지.

[설명용 주석 절대 금지]
다음과 같은 자기-설명 주석/메타-주석을 절대 추가하지 마세요. 사용자가 보기에 혼란스럽고 빌드 에러의 원인 추적을 어렵게 만듭니다.
- "Intentional SSR-breaking ..."
- "Moved to useEffect to be SSR-safe"
- "SSR-safe"
- "browser only"
- "guarded by typeof window"
- "TODO: ...", "FIXME: ...", "NOTE: ..."

기존에 있던 주석은 그대로 두되, 새로 추가하지 마세요.

[추가가 아닌 "축소" 금지]
- 기존 useState/useEffect/useRef/useMemo/useCallback/useReducer 호출을 절대 제거하지 마세요.
- 기존 import에서 사용 중인 named import를 절대 제거하지 마세요.
- "리팩터링 김에" 코드를 단순화하지 마세요. 오직 브라우저 API 가드/이동만 수행하세요.

[Server Component 안전 수칙(매우 중요) — \`dynamic(..., { ssr: false })\` 사용 금지]
- 이 작업에서는 절대 \`dynamic(...)\` 호출을 새로 만들거나 \`{ ssr: false }\` 옵션을 추가하지 마세요. \`next/dynamic\` import 도 추가 금지.
- \`ssr: false\` 는 Next.js App Router 의 Server Component (\`'use client'\` 가 없거나 \`export const metadata\`/\`generateMetadata\` 를 가진 \`page.tsx\`/\`layout.tsx\`/\`template.tsx\` 등) 에 들어가면 빌드 자체가 실패합니다 ("ssr: false is not allowed with next/dynamic in Server Components").
- 이미 파일에 \`dynamic(..., { ssr: false })\` 가 있더라도 그대로 유지하고, 새로 추가하지 마세요. 옵션을 옮기거나 변경하지도 마세요.
- 브라우저 API 보호는 (A) \`typeof window\` 가드 또는 (B) useEffect 이동, 그리고 필요한 파일에만 \`'use client'\` 한 줄 추가 — 이 세 가지로만 해결합니다. \`dynamic({ ssr: false })\` 는 이 작업의 도구가 아닙니다.

[자기 검증 체크리스트 — 출력 직전에 반드시 수행]
각 파일에 대해 순서대로 점검. 하나라도 NO면 그 파일은 원본 그대로 반환하세요.
- [ ] 원본의 모든 import가 그대로 유지되는가? (브라우저 API 보호를 위해 새 hook을 추가할 때만 named import에 추가, 절대 삭제 없음)
- [ ] 원본에 있던 모든 useState/useEffect/useRef/useMemo/useCallback/useReducer 호출이 그대로 남아있는가?
- [ ] JSX에서 참조하는 모든 변수/함수가 여전히 정의되어 있는가?
- [ ] 변경 사항이 오직 (a) 브라우저 API 가드 추가, (b) 모듈 스코프 → 함수/effect 안으로 이동, (c) 'use client' 추가뿐인가?
- [ ] 이미 \`typeof window\` 등으로 가드된 코드를 중복 처리하지 않았는가?
- [ ] 같은 변수에 가드(A)와 이동(B) 두 전략을 동시에 적용하지 않았는가?
- [ ] 모듈 스코프에 남은 모든 \`let\`/\`const\`/\`var\` 선언이 파일 안에서 최소 1회 이상 참조되는가? (이동 전략을 썼다면 원본 모듈-스코프 선언과 그 주변 \`if (typeof window ...)\` 블록을 모두 삭제했는가?)
- [ ] "Intentional SSR-breaking", "Moved to useEffect to be SSR-safe", "SSR-safe", "browser only" 같은 자기-설명 주석을 추가하지 않았는가?

[좋은 예 — 모듈 스코프 가드]
원본:
\`\`\`
const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
export const Theme = () => <div>{isDark ? 'dark' : 'light'}</div>;
\`\`\`
수정 후(허용):
\`\`\`
const isDark = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)').matches
  : false;
export const Theme = () => <div>{isDark ? 'dark' : 'light'}</div>;
\`\`\`

[좋은 예 — 렌더 중 접근 → useEffect로]
원본:
\`\`\`
'use client';
import { useState } from 'react';
export default function Width() {
  const [w, setW] = useState(window.innerWidth);
  return <div>{w}</div>;
}
\`\`\`
수정 후(허용 — 기존 useState 호출/import는 보존, useEffect만 추가):
\`\`\`
'use client';
import { useState, useEffect } from 'react';
export default function Width() {
  const [w, setW] = useState(0);
  useEffect(() => { setW(window.innerWidth); }, []);
  return <div>{w}</div>;
}
\`\`\`

[좋은 예 — 모듈 스코프 변수: 가드(A)만 사용]
원본:
\`\`\`
let initialScrollY = window.scrollY || 0;
export function useMovies() {
  const [y] = useState(initialScrollY);
  return y;
}
\`\`\`
수정 후(허용 — 가드만 적용, 변수 이름/위치/사용처 보존):
\`\`\`
let initialScrollY = 0;
if (typeof window !== 'undefined') {
  initialScrollY = window.scrollY || 0;
}
export function useMovies() {
  const [y] = useState(initialScrollY);
  return y;
}
\`\`\`

[좋은 예 — 모듈 스코프 변수: 이동(B)만 사용]
원본:
\`\`\`
let initialScrollY = window.scrollY || 0;
export function useMovies() {
  const [y] = useState(initialScrollY);
  return y;
}
\`\`\`
수정 후(허용 — 모듈-스코프 원본 선언과 가드 블록 모두 삭제, useState/useEffect로 완전 이동):
\`\`\`
'use client';
import { useState, useEffect } from 'react';
export function useMovies() {
  const [y, setY] = useState(0);
  useEffect(() => { setY(window.scrollY || 0); }, []);
  return y;
}
\`\`\`

[나쁜 예 — initialScrollY 잔재로 빌드 에러(절대 금지)]
원본:
\`\`\`
let initialScrollY = window.scrollY || 0;
export function useMovies() {
  const [y] = useState(initialScrollY);
  return y;
}
\`\`\`
잘못된 수정(가드(A)와 이동(B)을 동시에 적용 — 모듈-스코프 \`initialScrollY\`가 사용처 없이 남아 \`Type error: 'initialScrollY' is declared but its value is never read.\` 빌드 에러 발생):
\`\`\`
// Intentional SSR-breaking: window access at module top-level
// Moved to useEffect to be SSR-safe
let initialScrollY = 0;
if (typeof window !== 'undefined') {
  initialScrollY = window.scrollY || 0;
}
'use client';
import { useState, useEffect } from 'react';
export function useMovies() {
  const [y, setY] = useState(0);
  useEffect(() => { setY(window.scrollY || 0); }, []);
  return y;
}
\`\`\`
이 경우 올바른 동작: 위 [좋은 예 — 가드(A)] 또는 [좋은 예 — 이동(B)] 중 정확히 한 가지만 적용. 두 전략 동시 적용 절대 금지.

[나쁜 예 — 절대 이렇게 하지 마세요]
원본:
\`\`\`
'use client';
import { useState, useEffect } from 'react';
export default function Counter() {
  const [n, setN] = useState(0);
  useEffect(() => { document.title = String(n); }, [n]);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
\`\`\`
잘못된 수정(금지 — useState/useEffect 호출이 사라지고 import도 망가짐):
\`\`\`
'use client';
export default function Counter() {
  if (typeof document !== 'undefined') document.title = '0';
  return <button>0</button>;
}
\`\`\`
이 경우 올바른 동작: \`document.title = String(n)\`은 이미 useEffect 안에 있어 SSR 안전합니다. 이 파일은 변경 불필요. 원본 그대로 반환.

[불확실할 때의 기본 동작]
- 안전하게 가드/이동할 수 없으면 원본을 그대로 반환하세요.
- 이미 보호되어 있는(typeof window 등) 코드는 다시 건드리지 마세요.
- 변경할 파일이 하나도 없다면 \`{"files":[]}\`로 반환해도 됩니다.

[출력 형식]
- 변경한 파일만 files 배열에 포함.
- 새 파일 생성 금지.
- 불필요한 TODO/FIXME/NOTE 주석 추가 금지.

반드시 서버에서 실행 가능한 코드만 남기고, 동작을 최대한 유지하세요.`,
    manualFallback: `수동 처리 필요: 브라우저 전용 API 사용 코드를 Next.js(App Router) 서버/클라이언트 경계에 맞게 보호/분리하세요.\n- 후보 파일(일부): ${candidateRelPathsArr
      .slice(0, 20)
      .join(', ')}${candidateRelPathsArr.length > 20 ? ' ...' : ''}\n- 'use client' 적용 여부/typeof window 가드 등을 확인하세요.`,
    candidateRelPaths: candidateRelPathsArr,
  });

  // 참고: Gemini 적용 직후 결정론적 sweep(dead-guard 제거 + 메타-주석 정리)은
  // 공용 통로인 runAskApply(app/src/utils/ai-file-apply.cjs) 안에서 자동으로 수행됩니다.
}

// 참고: 결정론적 dead-guard sweep 로직은 공용 유틸로 이동했습니다.
// → app/src/utils/post-ai-sweep.cjs (모든 Gemini 적용 직후 자동 실행)

module.exports = {
  // NOTE:
  // migrateBrowserAPIs에서는 이제 위 handler들을 직접 호출하지 않고,
  // 브라우저 전용 API 후보 파일을 수집한 뒤 stopAndOfferGeminiApply로 AI가 일괄 수정합니다.
  // 아래 handle* 들은 레거시/참고용으로만 남겨둡니다(삭제하지 않음).
  // handleVariableDeclaration,
  // handleSideEffectLogic,
  // handleRenderingValue,
  // handleDOMEventHandler,
  // handleVoidReference,
  // handleLibInitialization,
  migrateBrowserAPIs,
};
