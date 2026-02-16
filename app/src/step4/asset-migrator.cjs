// src/step4/asset-migrator.cjs
// 정적 리소스(이미지/아이콘) 마이그레이션

const fs = require('fs-extra');
const path = require('path');

//=========================================================
//정적 리소스 마이그레이션 메인 함수
//=========================================================
async function migrateStaticResources(projectRoot) {
  // Case a: 정적 리소스 위치 정리 (src/assets -> public/assets)
  await migrateImageAssets(projectRoot);

  // Case b: 정적 리소스 참조 경로 수정
  await migrateAssetReferences(projectRoot);

  // Case c: favicon 처리
  await migrateFavicon(projectRoot);
}

//=========================================================
//Case a: src/assets 하위 정적 리소스를 public/assets로 이동
//=========================================================
async function migrateImageAssets(projectRoot) {
  const srcAssetsDir = path.join(projectRoot, 'src', 'assets');
  const publicAssetsDir = path.join(projectRoot, 'public', 'assets');

  // 1. src/assets 디렉터리 존재 여부 확인
  if (!fs.existsSync(srcAssetsDir)) {
    return; // 존재하지 않으면 본 case 수행하지 않음
  }

  // 2. public/assets 디렉터리 존재 여부 확인 및 생성
  if (!fs.existsSync(publicAssetsDir)) {
    await fs.ensureDir(publicAssetsDir);
  }

  // 3. src/assets 디렉터리 하위의 모든 파일과 하위 디렉터리를 public/assets로 이동
  const items = await fs.readdir(srcAssetsDir, { withFileTypes: true });
  
  for (const item of items) {
    const sourcePath = path.join(srcAssetsDir, item.name);
    const destPath = path.join(publicAssetsDir, item.name);
    
    await fs.move(sourcePath, destPath, { overwrite: true });
  }

  // 4. 이동 후 src/assets 디렉터리에 더 이상 파일이 남아있지 않다면 삭제
  const remainingItems = await fs.readdir(srcAssetsDir);
  if (remainingItems.length === 0) {
    await fs.remove(srcAssetsDir);
  }
}


//=========================================================
//Case b: 정적 리소스 참조 경로 수정
//=========================================================
async function migrateAssetReferences(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  if (!fs.existsSync(srcDir)) {
    return;
  }

  // src/ 디렉터리 하위의 모든 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        // node_modules, .next 등 제외
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

  // 파일 내 정적 리소스 참조 경로 수정
  async function processAssetReferencesInFile(filePath, projectRoot) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 1. import 방식 처리
    async function processImportBasedReferences(content, filePath, projectRoot) {
      // import ... from ".../assets/..." 또는 import ... from "@/assets/..." 패턴 찾기
      const importPattern = /import\s+(\w+)\s+from\s+["']([^"']*\/assets\/[^"']+)["']/g;
      const imports = [];
      let match;

      while ((match = importPattern.exec(content)) !== null) {
        imports.push({
          variableName: match[1],
          importPath: match[2],
          fullMatch: match[0],
        });
      }

      for (const imp of imports) {
        // 쿼리 문자열 제거 (?url, ?raw 등)
        const cleanPath = imp.importPath.split('?')[0];
        
        // 상대 경로 또는 alias 경로를 실제 경로로 변환
        let actualPath = cleanPath;
        if (cleanPath.startsWith('@/')) {
          actualPath = cleanPath.replace('@/', 'src/');
        } else if (cleanPath.startsWith('./') || cleanPath.startsWith('../')) {
          const fileDir = path.dirname(filePath);
          actualPath = path.resolve(fileDir, cleanPath);
        } else {
          actualPath = path.join(projectRoot, cleanPath);
        }

        // src/assets 하위인지 확인
        const srcAssetsDir = path.join(projectRoot, 'src', 'assets');
        if (actualPath.startsWith(srcAssetsDir)) {
          // 상대 경로 계산 (src/assets 기준)
          const relativePath = path.relative(srcAssetsDir, actualPath);
          const newPath = `/assets/${relativePath.replace(/\\/g, '/')}`;

          // src={variableName} 패턴을 src="/assets/..." 로 변경
          const srcPattern = new RegExp(`src=\\{${imp.variableName}\\}`, 'g');
          content = content.replace(srcPattern, `src="${newPath}"`);

          // 변수가 더 이상 사용되지 않으면 import 구문 삭제
          const variableUsagePattern = new RegExp(`\\b${imp.variableName}\\b`, 'g');
          const usages = content.match(variableUsagePattern) || [];
          if (usages.length === 1) {
            // import 구문만 남았으면 삭제
            const importLinePattern = new RegExp(`import\\s+${imp.variableName}\\s+from\\s+["'][^"']*["'];?\\s*\\n?`, 'g');
            content = content.replace(importLinePattern, '');
          }
        }
      }

      return content;
    }

    // 2. 문자열 경로 방식 처리
    async function processStringBasedReferences(content, filePath, projectRoot) {
      const fileDir = path.dirname(filePath);
      const srcAssetsDir = path.join(projectRoot, 'src', 'assets');

      // <img src="..." /> 또는 <Image src="..." /> 패턴 찾기
      const imgPattern = /<(img|Image)\s+[^>]*src=["']([^"']+)["'][^>]*>/g;
      let match;

      while ((match = imgPattern.exec(content)) !== null) {
        const srcValue = match[2];
        let newPath = null;

        // @/assets/... -> /assets/...
        if (srcValue.startsWith('@/assets/')) {
          newPath = srcValue.replace('@/assets/', '/assets/');
        }
        // /src/assets/... -> /assets/...
        else if (srcValue.startsWith('/src/assets/')) {
          newPath = srcValue.replace('/src/assets/', '/assets/');
        }
        // ./assets/... 또는 ../assets/... 처리
        else if (srcValue.includes('/assets/')) {
          const resolvedPath = path.resolve(fileDir, srcValue);
          if (resolvedPath.startsWith(srcAssetsDir)) {
            const relativePath = path.relative(srcAssetsDir, resolvedPath);
            newPath = `/assets/${relativePath.replace(/\\/g, '/')}`;
          }
        }

        if (newPath) {
          const oldSrc = `src="${srcValue}"`;
          const newSrc = `src="${newPath}"`;
          content = content.replace(oldSrc, newSrc);
        }
      }

      return content;
    }

    // 3. src 포함 경로 방식 처리
    function processSrcIncludedReferences(content) {
      // /src/assets/... -> /assets/...
      content = content.replace(/\/src\/assets\//g, '/assets/');
      return content;
    }

    content = await processImportBasedReferences(content, filePath, projectRoot);
    content = await processStringBasedReferences(content, filePath, projectRoot);
    content = processSrcIncludedReferences(content);

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processAssetReferencesInFile(filePath, projectRoot);
  }
}

//=========================================================
//Case c: Favicon 처리
//=========================================================
async function migrateFavicon(projectRoot) {
  const publicDir = path.join(projectRoot, 'public');
  const publicAssetsDir = path.join(publicDir, 'assets');
  const srcDir = path.join(projectRoot, 'src');
  const srcAssetsDir = path.join(srcDir, 'assets');

  // favicon 파일 목록 (표준 이름 + index.html에서 찾은 파일)
  const faviconFiles = new Set();

  // 1-1. index.html에서 <link rel="icon"> 태그 확인
  const indexHtmlPath = path.join(projectRoot, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    const indexHtmlContent = await fs.readFile(indexHtmlPath, 'utf-8');
    // <link rel="icon" ... href="..."> 패턴 찾기
    const iconLinkPattern = /<link\s+[^>]*rel\s*=\s*["'](?:icon|shortcut\s+icon)["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i;
    const match = indexHtmlContent.match(iconLinkPattern);
    if (match) {
      const iconHref = match[1];
      // /로 시작하는 절대 경로인 경우 / 제거
      const iconPath = iconHref.startsWith('/') ? iconHref.slice(1) : iconHref;
      // public/ 또는 src/ 경로인 경우 파일명만 추출
      const iconFileName = iconPath.replace(/^(public|src)\//, '').replace(/^assets\//, '');
      if (iconFileName) {
        faviconFiles.add(iconFileName);
      }
    }
  }

  // 1-2. 표준 favicon 이름도 확인
  const standardFaviconNames = ['favicon.ico', 'favicon.png', 'favicon.svg'];
  standardFaviconNames.forEach(name => faviconFiles.add(name));

  // 2. favicon 파일이 src/assets 또는 src/ 내부에 존재하면 /public 디렉터리로 이동
  // 재귀적으로 디렉터리를 스캔하여 favicon 파일 찾기
  async function findFaviconInDirectory(dir, fileName, excludeDirs = []) {
    if (!fs.existsSync(dir)) {
      return null;
    }

    const items = await fs.readdir(dir, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      
      // 제외할 디렉터리인지 확인
      if (item.isDirectory()) {
        const shouldExclude = excludeDirs.some(excludeDir => {
          const excludePath = path.resolve(excludeDir);
          const currentPath = path.resolve(fullPath);
          return currentPath.startsWith(excludePath);
        });
        
        if (!shouldExclude) {
          const found = await findFaviconInDirectory(fullPath, fileName, excludeDirs);
          if (found) {
            return found;
          }
        }
      } else if (item.isFile() && item.name === fileName) {
        return fullPath;
      }
    }
    
    return null;
  }

  for (const faviconFileName of faviconFiles) {
    let sourcePath = null;

    // Case a에서 이미 public/assets/favicon.*로 이동된 경우 확인
    if (fs.existsSync(publicAssetsDir)) {
      sourcePath = await findFaviconInDirectory(publicAssetsDir, faviconFileName);
    }
    
    // src/assets 디렉터리 내에서 재귀적으로 찾기
    if (!sourcePath && fs.existsSync(srcAssetsDir)) {
      sourcePath = await findFaviconInDirectory(srcAssetsDir, faviconFileName);
    }
    
    // src/ 디렉터리 내에서 재귀적으로 찾기 (src/assets는 제외)
    if (!sourcePath && fs.existsSync(srcDir)) {
      sourcePath = await findFaviconInDirectory(srcDir, faviconFileName, [srcAssetsDir]);
    }

    // favicon 파일이 존재하면 /public 디렉터리 루트로 이동 (파일명과 확장자는 변경하지 않음)
    if (sourcePath) {
      const destPath = path.join(publicDir, faviconFileName);
      await fs.move(sourcePath, destPath, { overwrite: true });
    }
  }

  // 3. Next.js는 public/favicon.ico를 자동 인식하므로 별도 import 또는 metadata 설정은 추가하지 않는다.
}

module.exports = {
  migrateStaticResources,
};

