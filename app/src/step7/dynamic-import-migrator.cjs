// src/step7/dynamic-import-migrator.cjs
// Dynamic Import 적용

const fs = require('fs-extra');
const path = require('path');

//=========================================================
// Dynamic Import 적용 메인 함수
//=========================================================
async function optimizeDynamicImport(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  
  // src/ 디렉터리가 존재하지 않으면 종료
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // Case a: 조건부 렌더링 컴포넌트
  await migrateConditionalRenderingComponents(projectRoot);

  // Case b: 브라우저 전용 API 사용하는 컴포넌트
  await migrateBrowserAPIComponents(projectRoot);

  // Case c: 이벤트 핸들러 내부에서만 사용하는 외부 라이브러리
  await migrateEventHandlerLibraries(projectRoot);

  // Case d: React.lazy 사용 코드
  await migrateReactLazy(projectRoot);

  // Case e: 대형 UI 라이브러리 컴포넌트
  await migrateLargeUIComponents(projectRoot);
}

//=========================================================
// Case a: 조건부 렌더링 컴포넌트
//=========================================================
async function migrateConditionalRenderingComponents(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 2. JSX 내부에서 조건부 렌더링 패턴 찾기
    // 조건 && <ComponentIdentifier /> 또는 조건 ? <ComponentIdentifier /> : null
    const conditionalPatterns = [
      // 조건 && <ComponentIdentifier />
      /(\w+)\s*&&\s*<(\w+)\s*[^>]*\/>/g,
      // 조건 ? <ComponentIdentifier /> : null
      /(\w+)\s*\?\s*<(\w+)\s*[^>]*\/>\s*:\s*null/g,
    ];

    const componentIdentifiers = new Set();

    for (const pattern of conditionalPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const componentIdentifier = match[2];
        componentIdentifiers.add(componentIdentifier);
      }
    }

    if (componentIdentifiers.size === 0) {
      return; // 조건부 렌더링 패턴이 없으면 종료
    }

    // 3. 파일 최상단에서 정적 import 확인
    const importsToConvert = [];
    for (const componentIdentifier of componentIdentifiers) {
      // import ComponentIdentifier from "ComponentImportPath" 패턴 찾기
      const importPattern = new RegExp(`import\\s+${componentIdentifier}\\s+from\\s+["']([^"']+)["']`, 'g');
      let importMatch;
      while ((importMatch = importPattern.exec(content)) !== null) {
        importsToConvert.push({
          componentIdentifier,
          importPath: importMatch[1],
          fullMatch: importMatch[0],
        });
      }
    }

    if (importsToConvert.length === 0) {
      return; // 변환할 import가 없으면 종료
    }

    // 4. 해당 import 문 제거
    // 5. 제거한 자리에 import dynamic from "next/dynamic" 추가
    const hasDynamicImport = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(content);
    
    for (const imp of importsToConvert) {
      // import 문 제거
      content = content.replace(imp.fullMatch, '');
    }

    // dynamic import 추가 (없는 경우)
    if (!hasDynamicImport) {
      const firstImportMatch = content.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        content = content.slice(0, insertIndex) +
          'import dynamic from "next/dynamic";\n' +
          content.slice(insertIndex);
      } else {
        content = 'import dynamic from "next/dynamic";\n' + content;
      }
    }

    // 6. 기존 import를 dynamic import로 변경
    for (const imp of importsToConvert) {
      // const ComponentIdentifier = dynamic(() => import("ComponentImportPath")) 형태로 추가
      const dynamicImportLine = `const ${imp.componentIdentifier} = dynamic(() => import("${imp.importPath}"));\n`;
      
      // 첫 번째 import 문 다음에 추가
      const firstImportMatch = content.match(/^import\s+[^;]+;?\s*\n/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index + firstImportMatch[0].length;
        content = content.slice(0, insertIndex) +
          dynamicImportLine +
          content.slice(insertIndex);
      } else {
        content = dynamicImportLine + content;
      }
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case b: 브라우저 전용 API 사용하는 컴포넌트
//=========================================================
async function migrateBrowserAPIComponents(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 2. 컴포넌트 내부 코드에서 브라우저 API 사용 여부 확인
    const browserAPIs = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage'];
    const browserAPIPattern = new RegExp(`\\b(${browserAPIs.join('|')})\\.`, 'g');
    
    if (!browserAPIPattern.test(content)) {
      return; // 브라우저 API 사용이 없으면 종료
    }

    // 3. 해당 API가 컴포넌트 렌더링 단계(함수 본문)에서 사용되는지 확인
    // 함수 컴포넌트 내부에서 사용되는지 확인
    const functionComponentPattern = /(?:export\s+)?(?:default\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{([^}]+)\}/g;
    const componentsWithBrowserAPI = [];

    let match;
    while ((match = functionComponentPattern.exec(content)) !== null) {
      const componentBody = match[2];
      if (browserAPIPattern.test(componentBody)) {
        componentsWithBrowserAPI.push(match[1]);
      }
    }

    if (componentsWithBrowserAPI.length === 0) {
      return; // 컴포넌트 렌더링 단계에서 사용되지 않으면 종료
    }

    // 4. 위 API를 사용하는 컴포넌트가 다른 파일에서 정적 import 되어 있는지 검사
    const importsToConvert = [];
    for (const componentName of componentsWithBrowserAPI) {
      // import ComponentIdentifier from "ComponentImportPath" 패턴 찾기
      const importPattern = new RegExp(`import\\s+${componentName}\\s+from\\s+["']([^"']+)["']`, 'g');
      let importMatch;
      while ((importMatch = importPattern.exec(content)) !== null) {
        importsToConvert.push({
          componentIdentifier: componentName,
          importPath: importMatch[1],
          fullMatch: importMatch[0],
        });
      }
    }

    // 다른 파일에서 import하는 경우를 찾기 위해 모든 파일 검사
    const allFiles = await findTsFiles(srcDir);
    for (const otherFilePath of allFiles) {
      if (otherFilePath === filePath) continue;
      
      const otherContent = await fs.readFile(otherFilePath, 'utf-8');
      for (const componentName of componentsWithBrowserAPI) {
        const importPattern = new RegExp(`import\\s+${componentName}\\s+from\\s+["']([^"']+)["']`, 'g');
        let importMatch;
        while ((importMatch = importPattern.exec(otherContent)) !== null) {
          importsToConvert.push({
            componentIdentifier: componentName,
            importPath: importMatch[1],
            fullMatch: importMatch[0],
            filePath: otherFilePath,
          });
        }
      }
    }

    if (importsToConvert.length === 0) {
      return; // 변환할 import가 없으면 종료
    }

    // 5-7. import 문 제거, dynamic import 추가, ssr: false 옵션 추가
    for (const imp of importsToConvert) {
      const targetFilePath = imp.filePath || filePath;
      let targetContent = await fs.readFile(targetFilePath, 'utf-8');
      const originalTargetContent = targetContent;

      // import 문 제거
      targetContent = targetContent.replace(imp.fullMatch, '');

      // dynamic import 추가
      const hasDynamicImport = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(targetContent);
      if (!hasDynamicImport) {
        const firstImportMatch = targetContent.match(/^import\s+/m);
        if (firstImportMatch) {
          const insertIndex = firstImportMatch.index;
          targetContent = targetContent.slice(0, insertIndex) +
            'import dynamic from "next/dynamic";\n' +
            targetContent.slice(insertIndex);
        } else {
          targetContent = 'import dynamic from "next/dynamic";\n' + targetContent;
        }
      }

      // dynamic import 선언 추가 (ssr: false 옵션 포함)
      const dynamicImportLine = `const ${imp.componentIdentifier} = dynamic(() => import("${imp.importPath}"), { ssr: false });\n`;
      
      const firstImportMatch = targetContent.match(/^import\s+[^;]+;?\s*\n/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index + firstImportMatch[0].length;
        targetContent = targetContent.slice(0, insertIndex) +
          dynamicImportLine +
          targetContent.slice(insertIndex);
      } else {
        targetContent = dynamicImportLine + targetContent;
      }

      // 변경사항이 있으면 파일 저장
      if (targetContent !== originalTargetContent) {
        await fs.writeFile(targetFilePath, targetContent, 'utf-8');
      }
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case c: 이벤트 핸들러 내부에서만 사용하는 외부 라이브러리
//=========================================================
async function migrateEventHandlerLibraries(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 2. 파일 최상단 import에서 외부 라이브러리 import 찾기
    const importPattern = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;
    const imports = [];
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      const libraryIdentifier = match[1];
      const libraryImportPath = match[2];
      
      // node_modules에서 가져오는 외부 라이브러리인지 확인
      if (libraryImportPath.startsWith('.') || libraryImportPath.startsWith('@/')) {
        continue; // 로컬 파일이면 건너뛰기
      }

      imports.push({
        libraryIdentifier,
        libraryImportPath,
        fullMatch: match[0],
      });
    }

    if (imports.length === 0) {
      return; // 외부 라이브러리 import가 없으면 종료
    }

    // 3. LibraryIdentifier가 이벤트 핸들러 내부에서만 사용되는지 확인
    const eventHandlerPatterns = [
      /(?:onClick|onChange|onSubmit|onInput|onFocus|onBlur)\s*=\s*\{[^}]*\}/g,
      /(?:handle\w+|on\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{[^}]*\}/g,
      /(?:async\s+)?function\s+(?:handle\w+|on\w+)\s*\([^)]*\)\s*\{[^}]*\}/g,
    ];

    const importsToConvert = [];

    for (const imp of imports) {
      // 이벤트 핸들러 내부에서 사용되는지 확인
      let usedInEventHandler = false;
      let usedOutsideEventHandler = false;

      for (const pattern of eventHandlerPatterns) {
        const handlerMatches = content.matchAll(pattern);
        for (const handlerMatch of handlerMatches) {
          const handlerContent = handlerMatch[0];
          // 이벤트 핸들러 내부에서 사용되는지 확인
          if (new RegExp(`\\b${imp.libraryIdentifier}\\b`).test(handlerContent)) {
            usedInEventHandler = true;
          }
        }
      }

      // 이벤트 핸들러 외부에서 사용되는지 확인
      // 전체 파일에서 이벤트 핸들러를 제외한 부분 확인
      let remainingContent = content;
      for (const pattern of eventHandlerPatterns) {
        remainingContent = remainingContent.replace(pattern, '');
      }
      if (new RegExp(`\\b${imp.libraryIdentifier}\\b`).test(remainingContent)) {
        usedOutsideEventHandler = true;
      }

      // 이벤트 핸들러 내부에서만 사용되고 외부에서는 사용되지 않는 경우
      if (usedInEventHandler && !usedOutsideEventHandler) {
        importsToConvert.push(imp);
      }
    }

    if (importsToConvert.length === 0) {
      return; // 변환할 import가 없으면 종료
    }

    // 4. 해당 import 문 제거
    for (const imp of importsToConvert) {
      content = content.replace(imp.fullMatch, '');
    }

    // 5. 이벤트 핸들러 내부에서 dynamic import 사용하도록 변경
    for (const imp of importsToConvert) {
      // 이벤트 핸들러 패턴 찾기
      for (const pattern of eventHandlerPatterns) {
        content = content.replace(pattern, (handlerMatch) => {
          // 이벤트 핸들러 내부에서 LibraryIdentifier 사용하는지 확인
          if (new RegExp(`\\b${imp.libraryIdentifier}\\b`).test(handlerMatch)) {
            // async 함수로 변경 (아직 async가 아닌 경우)
            let newHandler = handlerMatch;
            if (!newHandler.includes('async')) {
              newHandler = newHandler.replace(/(?:const\s+)?(\w+)\s*=\s*(?:async\s*)?\(/, 'const $1 = async (');
              newHandler = newHandler.replace(/(?:async\s+)?function\s+(\w+)\s*\(/, 'async function $1 (');
            }
            
            // 이벤트 핸들러 시작 부분에 dynamic import 추가
            const dynamicImportLine = `const ${imp.libraryIdentifier} = (await import("${imp.libraryImportPath}")).default;\n`;
            
            // 함수 본문 시작 부분 찾기
            const bodyStartIndex = newHandler.indexOf('{');
            if (bodyStartIndex !== -1) {
              newHandler = newHandler.slice(0, bodyStartIndex + 1) +
                '\n' + dynamicImportLine +
                newHandler.slice(bodyStartIndex + 1);
            }
            
            return newHandler;
          }
          return handlerMatch;
        });
      }
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case d: React.lazy 사용 코드
//=========================================================
async function migrateReactLazy(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 1. React.lazy 패턴 찾기
    // const ComponentIdentifier = React.lazy(() => import("ComponentImportPath"))
    const reactLazyPattern = /const\s+(\w+)\s*=\s*React\.lazy\s*\(\s*\(\)\s*=>\s*import\s*\(["']([^"']+)["']\)\s*\)/g;
    const lazyComponents = [];
    let match;

    while ((match = reactLazyPattern.exec(content)) !== null) {
      lazyComponents.push({
        componentIdentifier: match[1],
        importPath: match[2],
        fullMatch: match[0],
      });
    }

    if (lazyComponents.length === 0) {
      return; // React.lazy 패턴이 없으면 종료
    }

    // 3. 해당 코드 제거
    for (const lazy of lazyComponents) {
      content = content.replace(lazy.fullMatch, '');
    }

    // 4. 파일 상단에 import dynamic from "next/dynamic" 추가
    const hasDynamicImport = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(content);
    if (!hasDynamicImport) {
      const firstImportMatch = content.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        content = content.slice(0, insertIndex) +
          'import dynamic from "next/dynamic";\n' +
          content.slice(insertIndex);
      } else {
        content = 'import dynamic from "next/dynamic";\n' + content;
      }
    }

    // 5. dynamic import 형태로 변경
    for (const lazy of lazyComponents) {
      const dynamicImportLine = `const ${lazy.componentIdentifier} = dynamic(() => import("${lazy.importPath}"));\n`;
      
      const firstImportMatch = content.match(/^import\s+[^;]+;?\s*\n/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index + firstImportMatch[0].length;
        content = content.slice(0, insertIndex) +
          dynamicImportLine +
          content.slice(insertIndex);
      } else {
        content = dynamicImportLine + content;
      }
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case e: 대형 UI 라이브러리 컴포넌트
//=========================================================
async function migrateLargeUIComponents(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 대형 UI 컴포넌트 목록
  const largeUIComponents = ['Chart', 'Editor', 'Map', 'Viewer', 'Player'];

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 2. 대형 UI 컴포넌트 import 여부 확인
    const importsToConvert = [];
    for (const componentName of largeUIComponents) {
      // import ComponentIdentifier from "ComponentImportPath" 패턴 찾기
      const importPattern = new RegExp(`import\\s+${componentName}\\s+from\\s+["']([^"']+)["']`, 'g');
      let importMatch;
      while ((importMatch = importPattern.exec(content)) !== null) {
        importsToConvert.push({
          componentIdentifier: componentName,
          importPath: importMatch[1],
          fullMatch: importMatch[0],
        });
      }
    }

    if (importsToConvert.length === 0) {
      return; // 대형 UI 컴포넌트 import가 없으면 종료
    }

    // 3. 해당 컴포넌트가 항상 초기 렌더에 필요하지 않은지 확인
    // (조건부 렌더링이거나 지연 로딩 가능한 경우)
    // 이 부분은 사용자가 수동으로 확인해야 하므로, 일단 모든 경우에 적용

    // 4. 대형 UI 컴포넌트 정적 import 제거
    for (const imp of importsToConvert) {
      content = content.replace(imp.fullMatch, '');
    }

    // 5. 제거한 자리에 import dynamic from "next/dynamic" 추가
    const hasDynamicImport = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(content);
    if (!hasDynamicImport) {
      const firstImportMatch = content.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        content = content.slice(0, insertIndex) +
          'import dynamic from "next/dynamic";\n' +
          content.slice(insertIndex);
      } else {
        content = 'import dynamic from "next/dynamic";\n' + content;
      }
    }

    // 6. dynamic import 형태로 변경
    for (const imp of importsToConvert) {
      const dynamicImportLine = `const ${imp.componentIdentifier} = dynamic(() => import("${imp.importPath}"));\n`;
      
      const firstImportMatch = content.match(/^import\s+[^;]+;?\s*\n/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index + firstImportMatch[0].length;
        content = content.slice(0, insertIndex) +
          dynamicImportLine +
          content.slice(insertIndex);
      } else {
        content = dynamicImportLine + content;
      }
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

module.exports = {
  optimizeDynamicImport,
};

