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

  // 1. 프로젝트 루트 기준으로 src/ 하위의 .ts, .tsx 파일 찾기
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
    const fileDir = path.dirname(filePath);
    const srcAssetsDir = path.join(projectRoot, 'src', 'assets');

    // 2. 파일 내부에서 JSX의 <img ... /> 태그 찾기
    // 3. JSX 내부의 src 속성이 src/assets를 참조하는지 확인
    // 3.1. import 변수 참조 형태: src={AssetIdentifier}
    // 3.2. 문자열 경로 형태: src="@/assets/...", src="/src/assets/...", src="./assets/...", src="../assets/..."

    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // import 경로를 Next public URL(/assets/...)로 변환
    const toPublicAssetPath = (importPathValue) => {
      const cleanPath = importPathValue.split('?')[0];

      if (cleanPath.startsWith('/assets/')) {
        return cleanPath;
      }
      if (cleanPath.startsWith('@assets/')) {
        return cleanPath.replace('@assets/', '/assets/');
      }
      if (cleanPath.startsWith('@/assets/')) {
        return cleanPath.replace('@/assets/', '/assets/');
      }
      if (cleanPath.startsWith('/src/assets/')) {
        return cleanPath.replace('/src/assets/', '/assets/');
      }
      if (cleanPath.startsWith('./') || cleanPath.startsWith('../')) {
        const resolvedPath = path.resolve(fileDir, cleanPath);
        if (resolvedPath.startsWith(srcAssetsDir)) {
          const relativePath = path.relative(srcAssetsDir, resolvedPath);
          return `/assets/${relativePath.replace(/\\/g, '/')}`;
        }
      }
      return null;
    };

    // 4. 파일 최상단에 import 문이 존재하는지 확인
    // import AssetIdentifier from "ImportPath" 형태 찾기
    const importPattern = /import\s+(\w+)\s+from\s+["']([^"']+)["']\s*;?/g;
    const imports = [];
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      const importPath = match[2];
      // 쿼리 문자열 제거 (?url, ?raw 등)
      const cleanPath = importPath.split('?')[0];
      
      const publicPath = toPublicAssetPath(cleanPath);
      if (publicPath) {
        imports.push({
          variableName: match[1],
          importPath: cleanPath,
          fullMatch: match[0],
          publicPath,
        });
      }
    }

    // 정책 A: src/assets import는 모듈 import를 유지하지 않고 URL 상수로 치환
    // (ternary, styled url(${icon}) 등 사용처 유지)
    for (const imp of imports) {
      const constDecl = `const ${imp.variableName} = '${imp.publicPath}';`;
      // fullMatch가 import 문 전체이므로, 정확히 치환해 import가 남는 문제를 방지한다.
      content = content.replace(imp.fullMatch, constDecl);
    }

    // 5. 문자열 기반 src 경로 치환
    // import 라인은 위에서 별도 처리하므로 제외하고 치환한다.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s+/.test(lines[i])) continue;
      lines[i] = lines[i]
        .replace(/["']@assets\/([^"']+)["']/g, '"/assets/$1"')
        .replace(/["']@\/assets\/([^"']+)["']/g, '"/assets/$1"')
        .replace(/["']\/src\/assets\/([^"']+)["']/g, '"/assets/$1"');
    }
    content = lines.join('\n');

    // 5.3. "./assets/..." 또는 "../assets/..." 처리
    // JSX 내부의 <img src="..." /> 태그에서 처리
    const imgTagPattern = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/g;
    let imgMatch;
    const imgReplacements = [];

    while ((imgMatch = imgTagPattern.exec(content)) !== null) {
      const srcValue = imgMatch[1];
      
      // 이미 "/assets/..." 형태이면 변경하지 않음 (6번 조건)
      if (srcValue.startsWith('/assets/')) {
        continue;
      }

      // "./assets/..." 또는 "../assets/..." 형태인지 확인
      if (srcValue.startsWith('./assets/') || srcValue.startsWith('../assets/')) {
        // 현재 파일 위치 기준으로 실제 경로 계산
        const resolvedPath = path.resolve(fileDir, srcValue);
        
        // src/assets를 가리키는 경우에만 변경
        if (resolvedPath.startsWith(srcAssetsDir)) {
          const relativePath = path.relative(srcAssetsDir, resolvedPath);
          const newPath = `/assets/${relativePath.replace(/\\/g, '/')}`;
          imgReplacements.push({
            old: `src="${srcValue}"`,
            new: `src="${newPath}"`,
          });
        }
        // 5.4. 현재 파일 위치 기준으로 계산한 결과가 src/assets/...가 아니면 변경하지 않음
      }
    }

    // img 태그의 src 값 변경
    for (const replacement of imgReplacements) {
      content = content.replace(replacement.old, replacement.new);
    }

    // import 변수 참조 형태 처리 (정책 A)
    // import는 제거하고 사용처를 "/assets/..." 문자열로 치환한다.
    for (const imp of imports) {
      const varNameEscaped = escapeRegExp(imp.variableName);
      const publicPathEscaped = imp.publicPath.replace(/\$/g, '$$$$');
      let replaced = false;

      // JSX 속성: src={icon}, href={icon}, poster={icon}
      const attrPatterns = [
        new RegExp(`\\bsrc\\s*=\\s*\\{\\s*${varNameEscaped}\\s*\\}`, 'g'),
        new RegExp(`\\bhref\\s*=\\s*\\{\\s*${varNameEscaped}\\s*\\}`, 'g'),
        new RegExp(`\\bposter\\s*=\\s*\\{\\s*${varNameEscaped}\\s*\\}`, 'g'),
      ];

      for (const pattern of attrPatterns) {
        content = content.replace(pattern, (m) => {
          replaced = true;
          const attrName = m.split('=')[0].trim();
          return `${attrName}="${publicPathEscaped}"`;
        });
      }

      // styled-components / CSS template literal: url(${icon})
      const urlPattern = new RegExp(`url\\(\\s*\\$\\{\\s*${varNameEscaped}\\s*\\}\\s*\\)`, 'g');
      if (urlPattern.test(content)) {
        content = content.replace(urlPattern, `url(${publicPathEscaped})`);
        replaced = true;
      }

      // import는 위에서 const 상수로 치환되므로 여기서는 제거하지 않는다.
    }

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


