// src/step7/next-font-migrator.cjs
// next/font 적용

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

//=========================================================
// next/font 적용 메인 함수
//=========================================================
async function applyNextFont(projectRoot) {
  // Case d 체크: 수동 처리 대상인지 확인
  await checkManualProcessingCases(projectRoot);

  // Case a: index.html에서 Google Fonts <link>를 사용하는 경우
  await migrateGoogleFontsFromIndexHtml(projectRoot);

  // Case b: CSS @import로 Google Fonts를 사용하는 경우
  await migrateGoogleFontsFromCssImport(projectRoot);

  // Case c: 로컬 폰트 파일을 CSS @font-face로 사용하는 경우
  await migrateLocalFontsFromFontFace(projectRoot);
}

//=========================================================
// Case d: 수동 처리 대상 체크
//=========================================================
async function checkManualProcessingCases(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const publicDir = path.join(projectRoot, 'public');

  // 3. CSS 변수(--font-...) 또는 font-family fallback 체인이 복잡하게 구성된 경우
  const cssFiles = [
    path.join(srcDir, 'index.css'),
    path.join(srcDir, 'app', 'globals.css'),
    path.join(srcDir, 'App.css'),
  ].filter(filePath => fs.existsSync(filePath));

  for (const cssFilePath of cssFiles) {
    const cssContent = await fs.readFile(cssFilePath, 'utf-8');
    
    // CSS 변수 사용 체크
    if (cssContent.includes('--font-') && cssContent.match(/font-family\s*:\s*var\(--font-[^)]+\)/g)) {
      throw new Error(
        chalk.red.bold('\n❌ 수동 처리 필요: CSS 변수(--font-...) 또는 font-family fallback 체인이 복잡하게 구성되어 있습니다.\n') +
        chalk.yellow('   개발자가 직접 next/font/google 또는 next/font/local로 변환해야 합니다.\n')
      );
    }
  }

  // 4. JS 코드에서 동적으로 폰트를 로드하는 경우 (FontFace, Load() 등)
  async function findTsFiles(dir) {
    const files = [];
    if (!fs.existsSync(dir)) {
      return files;
    }
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx|js|jsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const tsFiles = await findTsFiles(srcDir);
  for (const filePath of tsFiles) {
    const content = await fs.readFile(filePath, 'utf-8');
    
    // FontFace API 사용 체크
    if (content.includes('new FontFace') || content.includes('FontFace(')) {
      throw new Error(
        chalk.red.bold('\n❌ 수동 처리 필요: JS 코드에서 동적으로 폰트를 로드하는 경우 (FontFace API 사용)\n') +
        chalk.yellow('   개발자가 직접 next/font/local로 변환해야 합니다.\n')
      );
    }
    
    // document.fonts.load() 사용 체크
    if (content.includes('document.fonts.load') || content.includes('fonts.load(')) {
      throw new Error(
        chalk.red.bold('\n❌ 수동 처리 필요: JS 코드에서 동적으로 폰트를 로드하는 경우 (document.fonts.load 사용)\n') +
        chalk.yellow('   개발자가 직접 next/font/local로 변환해야 합니다.\n')
      );
    }
  }

  // 5. 외부 CDN에서 폰트를 직접 로드하는 경우 (Google Fonts 제외)
  const indexHtmlPath = path.join(projectRoot, 'index.html');
  const srcIndexHtmlPath = path.join(srcDir, 'index.html');
  
  for (const htmlPath of [indexHtmlPath, srcIndexHtmlPath]) {
    if (fs.existsSync(htmlPath)) {
      const htmlContent = await fs.readFile(htmlPath, 'utf-8');
      
      // Google Fonts가 아닌 외부 CDN 링크 체크
      const externalFontLinkPattern = /<link[^>]*href=["'](https?:\/\/[^"']*fonts?[^"']*)["'][^>]*>/gi;
      const fontLinks = htmlContent.match(externalFontLinkPattern);
      
      if (fontLinks) {
        for (const link of fontLinks) {
          if (!link.includes('fonts.googleapis.com') && !link.includes('fonts.gstatic.com')) {
            throw new Error(
              chalk.red.bold('\n❌ 수동 처리 필요: 외부 CDN에서 폰트를 직접 로드하는 경우\n') +
              chalk.yellow('   개발자가 직접 next/font/local로 변환해야 합니다.\n')
            );
          }
        }
      }
    }
  }
}

//=========================================================
// Case a: index.html에서 Google Fonts <link>를 사용하는 경우
//=========================================================
async function migrateGoogleFontsFromIndexHtml(projectRoot) {
  const indexHtmlPath = path.join(projectRoot, 'src', 'index.html');
  
  // src/index.html 파일이 존재하지 않으면 종료
  if (!fs.existsSync(indexHtmlPath)) {
    return;
  }

  const htmlContent = await fs.readFile(indexHtmlPath, 'utf-8');

  // 2. fonts.googleapis.com 또는 fonts.gstatic.com이 포함된 <link> 태그 확인
  const googleFontsLinkPattern = /<link\s+[^>]*(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/gi;
  const googleFontsLinks = htmlContent.match(googleFontsLinkPattern);

  if (!googleFontsLinks || googleFontsLinks.length === 0) {
    return;
  }

  // 3. href 값에서 FontFamilyIdentifier, WeightList, DisplayOption 추출
  let fontFamilyIdentifier = null;
  let weightList = null;
  let displayOption = 'swap';

  for (const linkTag of googleFontsLinks) {
    // css2 링크에서 정보 추출
    const css2Match = linkTag.match(/href=["']([^"']*fonts\.googleapis\.com\/css2[^"']*)["']/);
    if (css2Match) {
      const href = css2Match[1];
      
      // 3.1. FontFamilyIdentifier: family= 파라미터 값
      const familyMatch = href.match(/family=([^:&]+)/);
      if (familyMatch) {
        fontFamilyIdentifier = familyMatch[1].replace(/\+/g, ' ');
        // PascalCase로 변환 (예: "Roboto" -> "Roboto", "Open Sans" -> "Open_Sans" -> "OpenSans")
        fontFamilyIdentifier = fontFamilyIdentifier
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join('');
      }

      // 3.2. WeightList: wght@ 파라미터 값
      const weightMatch = href.match(/wght@([^&]+)/);
      if (weightMatch) {
        weightList = weightMatch[1].split(';').map(w => parseInt(w.trim())).filter(w => !isNaN(w));
      }

      // 3.3. DisplayOption: display= 파라미터 값
      const displayMatch = href.match(/display=([^&]+)/);
      if (displayMatch) {
        displayOption = displayMatch[1];
      }
    }
  }

  // 여러 개의 family 파라미터가 동시에 존재하는 경우 수동 처리 대상
  const familyMatches = htmlContent.match(/family=([^:&]+)/g);
  if (familyMatches && familyMatches.length > 1) {
    throw new Error(
      chalk.red.bold('\n❌ 수동 처리 필요: Google Fonts URL에서 여러 개의 family 파라미터가 동시에 존재합니다.\n') +
      chalk.yellow('   개발자가 직접 next/font/google로 변환해야 합니다.\n')
    );
  }

  if (!fontFamilyIdentifier) {
    return; // 폰트 정보를 추출할 수 없으면 종료
  }

  // 4-6. src/app/layout.tsx에 import, 폰트 객체 추가, className 추가
  await addFontToLayout(projectRoot, {
    type: 'google',
    fontFamilyIdentifier,
    weightList,
    displayOption,
  });

  // 7. src/index.html의 Google Fonts 관련 <link> 태그 삭제
  let newHtmlContent = htmlContent;
  for (const linkTag of googleFontsLinks) {
    newHtmlContent = newHtmlContent.replace(linkTag, '');
  }
  // 빈 줄 정리
  newHtmlContent = newHtmlContent.replace(/\n\s*\n\s*\n/g, '\n\n');

  if (newHtmlContent !== htmlContent) {
    await fs.writeFile(indexHtmlPath, newHtmlContent, 'utf-8');
  }
}

//=========================================================
// Case b: CSS @import로 Google Fonts를 사용하는 경우
//=========================================================
async function migrateGoogleFontsFromCssImport(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const appDir = path.join(srcDir, 'app');
  
  // CSS 파일 검사 대상
  const cssFiles = [
    path.join(srcDir, 'index.css'),
    path.join(appDir, 'globals.css'),
    path.join(srcDir, 'App.css'),
  ].filter(filePath => fs.existsSync(filePath));

  for (const cssFilePath of cssFiles) {
    let cssContent = await fs.readFile(cssFilePath, 'utf-8');
    const originalContent = cssContent;

    // 2. @import url("https://fonts.googleapis.com 패턴 확인
    const importPattern = /@import\s+url\(["']([^"']*fonts\.googleapis\.com[^"']*)["']\)/gi;
    const importMatches = cssContent.match(importPattern);

    if (!importMatches || importMatches.length === 0) {
      continue;
    }

    // 여러 개의 family 파라미터가 동시에 존재하는 경우 수동 처리 대상
    const familyMatches = cssContent.match(/family=([^:&]+)/g);
    if (familyMatches && familyMatches.length > 1) {
      throw new Error(
        chalk.red.bold('\n❌ 수동 처리 필요: Google Fonts URL에서 여러 개의 family 파라미터가 동시에 존재합니다.\n') +
        chalk.yellow('   개발자가 직접 next/font/google로 변환해야 합니다.\n')
      );
    }

    // 3. import URL에서 FontFamilyIdentifier, WeightList, DisplayOption 추출
    let fontFamilyIdentifier = null;
    let weightList = null;
    let displayOption = 'swap';

    for (const importMatch of importMatches) {
      const urlMatch = importMatch.match(/url\(["']([^"']+)["']\)/);
      if (urlMatch) {
        const href = urlMatch[1];

        // 3.1. FontFamilyIdentifier: family= 파라미터 값
        const familyMatch = href.match(/family=([^:&]+)/);
        if (familyMatch) {
          fontFamilyIdentifier = familyMatch[1].replace(/\+/g, ' ');
          fontFamilyIdentifier = fontFamilyIdentifier
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
        }

        // 3.2. WeightList: wght@ 파라미터 값
        const weightMatch = href.match(/wght@([^&]+)/);
        if (weightMatch) {
          weightList = weightMatch[1].split(';').map(w => parseInt(w.trim())).filter(w => !isNaN(w));
        }

        // 3.3. DisplayOption: display= 파라미터 값
        const displayMatch = href.match(/display=([^&]+)/);
        if (displayMatch) {
          displayOption = displayMatch[1];
        }
      }
    }

    if (!fontFamilyIdentifier) {
      continue; // 폰트 정보를 추출할 수 없으면 다음 파일로
    }

    // 4-6. src/app/layout.tsx에 import, 폰트 객체 추가, className 추가
    await addFontToLayout(projectRoot, {
      type: 'google',
      fontFamilyIdentifier,
      weightList,
      displayOption,
    });

    // 7. CSS 파일의 Google Fonts @import 구문 삭제
    for (const importMatch of importMatches) {
      cssContent = cssContent.replace(importMatch, '');
    }
    // 빈 줄 정리
    cssContent = cssContent.replace(/\n\s*\n\s*\n/g, '\n\n');

    // 8. 기존 CSS의 font-family 선언은 유지 (아무것도 하지 않음)

    if (cssContent !== originalContent) {
      await fs.writeFile(cssFilePath, cssContent, 'utf-8');
    }
  }
}

//=========================================================
// Case c: 로컬 폰트 파일을 CSS @font-face로 사용하는 경우
//=========================================================
async function migrateLocalFontsFromFontFace(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const publicDir = path.join(projectRoot, 'public');
  
  // 1. src/ 또는 public/ 하위 폴더에서 .woff, .woff2, .ttf, .otf 파일 찾기
  async function findFontFiles(dir) {
    const fontFiles = [];
    if (!fs.existsSync(dir)) {
      return fontFiles;
    }

    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findFontFiles(fullPath);
          fontFiles.push(...subFiles);
        }
      } else if (/\.(woff|woff2|ttf|otf)$/i.test(item.name)) {
        fontFiles.push(fullPath);
      }
    }
    return fontFiles;
  }

  const fontFiles = [
    ...await findFontFiles(srcDir),
    ...await findFontFiles(publicDir),
  ];

  if (fontFiles.length === 0) {
    return; // 폰트 파일이 없으면 종료
  }

  // CSS 파일 검사 대상
  const cssFiles = [
    path.join(srcDir, 'index.css'),
    path.join(srcDir, 'app', 'globals.css'),
    path.join(srcDir, 'App.css'),
  ].filter(filePath => fs.existsSync(filePath));

  for (const cssFilePath of cssFiles) {
    const cssContent = await fs.readFile(cssFilePath, 'utf-8');

    // 2. CSS 파일에서 @font-face 선언 확인
    const fontFacePattern = /@font-face\s*\{([^}]+)\}/gi;
    const fontFaceMatches = cssContent.match(fontFacePattern);

    if (!fontFaceMatches || fontFaceMatches.length === 0) {
      continue;
    }

    // 여러 @font-face 선언이 하나의 font-family로 묶여 있는 경우 수동 처리 대상
    const fontFamilyNames = new Set();
    for (const fontFace of fontFaceMatches) {
      const familyMatch = fontFace.match(/font-family\s*:\s*["']?([^"';}]+)["']?/i);
      if (familyMatch) {
        fontFamilyNames.add(familyMatch[1].trim());
      }
    }

    if (fontFamilyNames.size === 1 && fontFaceMatches.length > 1) {
      // 같은 font-family로 여러 @font-face가 묶여 있음
      throw new Error(
        chalk.red.bold('\n❌ 수동 처리 필요: CSS에서 여러 @font-face 선언이 하나의 font-family로 묶여 있습니다.\n') +
        chalk.yellow('   개발자가 직접 next/font/local로 변환해야 합니다.\n')
      );
    }

    // 3. @font-face 블록에서 값 추출
    for (const fontFace of fontFaceMatches) {
      // 3.1. LocalFontFamilyName
      const familyMatch = fontFace.match(/font-family\s*:\s*["']?([^"';}]+)["']?/i);
      if (!familyMatch) continue;

      const localFontFamilyName = familyMatch[1].trim();

      // 3.2. LocalFontFilePath
      const srcMatch = fontFace.match(/src\s*:\s*url\(["']?([^"')]+)["']?\)/i);
      if (!srcMatch) continue;

      let localFontFilePath = srcMatch[1].trim();
      // 상대 경로를 절대 경로로 변환
      if (localFontFilePath.startsWith('./') || localFontFilePath.startsWith('../')) {
        const cssDir = path.dirname(cssFilePath);
        localFontFilePath = path.resolve(cssDir, localFontFilePath);
      } else if (localFontFilePath.startsWith('/')) {
        localFontFilePath = path.join(projectRoot, localFontFilePath.slice(1));
      }

      // 폰트 파일이 실제로 존재하는지 확인
      if (!fs.existsSync(localFontFilePath)) {
        continue; // 파일이 없으면 다음 @font-face로
      }

      // 프로젝트 루트 기준 상대 경로로 변환
      const relativePath = path.relative(projectRoot, localFontFilePath).replace(/\\/g, '/');
      if (!relativePath.startsWith('src/') && !relativePath.startsWith('public/')) {
        continue; // src/ 또는 public/ 하위가 아니면 건너뛰기
      }

      // 3.3. FontWeight
      const weightMatch = fontFace.match(/font-weight\s*:\s*([^;}+]+)/i);
      const fontWeight = weightMatch ? weightMatch[1].trim() : '400';

      // 3.4. FontStyle
      const styleMatch = fontFace.match(/font-style\s*:\s*([^;}+]+)/i);
      const fontStyle = styleMatch ? styleMatch[1].trim() : 'normal';

      // 4-6. src/app/layout.tsx에 import, 폰트 객체 추가, className 추가
      await addFontToLayout(projectRoot, {
        type: 'local',
        fontFamilyName: localFontFamilyName,
        fontFilePath: relativePath,
        fontWeight,
        fontStyle,
      });
    }
  }
}

//=========================================================
// layout.tsx에 폰트 추가 헬퍼 함수
//=========================================================
async function addFontToLayout(projectRoot, fontConfig) {
  const layoutPath = path.join(projectRoot, 'src', 'app', 'layout.tsx');

  if (!fs.existsSync(layoutPath)) {
    return; // layout.tsx가 없으면 종료
  }

  let layoutContent = await fs.readFile(layoutPath, 'utf-8');

  // Google Fonts인 경우
  if (fontConfig.type === 'google') {
    const fontFamilyIdentifier = fontConfig.fontFamilyIdentifier;
    const fontObjectIdentifier = fontFamilyIdentifier.charAt(0).toLowerCase() + fontFamilyIdentifier.slice(1) + 'Font';
    const weightList = fontConfig.weightList || [400];
    const displayOption = fontConfig.displayOption || 'swap';

    // import 문 추가 (이미 존재하는지 확인)
    const importPattern = new RegExp(`import\\s+\\{[^}]*${fontFamilyIdentifier}[^}]*\\}\\s+from\\s+["']next/font/google["']`, 'g');
    if (!importPattern.test(layoutContent)) {
      // 첫 번째 import 문 앞에 추가
      const firstImportMatch = layoutContent.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        layoutContent = layoutContent.slice(0, insertIndex) +
          `import { ${fontFamilyIdentifier} } from "next/font/google";\n` +
          layoutContent.slice(insertIndex);
      } else {
        layoutContent = `import { ${fontFamilyIdentifier} } from "next/font/google";\n` + layoutContent;
      }
    }

    // 폰트 객체 생성 (이미 존재하는지 확인)
    const fontObjectPattern = new RegExp(`const\\s+${fontObjectIdentifier}\\s*=`, 'g');
    if (!fontObjectPattern.test(layoutContent)) {
      // import 문 다음에 추가
      const lastImportMatch = layoutContent.match(/^import\s+[^;]+;?\s*\n/m);
      if (lastImportMatch) {
        const insertIndex = lastImportMatch.index + lastImportMatch[0].length;
        layoutContent = layoutContent.slice(0, insertIndex) +
          `\nconst ${fontObjectIdentifier} = ${fontFamilyIdentifier}({\n` +
          `  subsets: ["latin"],\n` +
          `  weight: [${weightList.join(', ')}],\n` +
          `  display: "${displayOption}",\n` +
          `});\n` +
          layoutContent.slice(insertIndex);
      }
    }

    // <html> 태그에 className 추가
    const htmlTagPattern = /<html([^>]*)>/;
    const htmlMatch = layoutContent.match(htmlTagPattern);
    if (htmlMatch) {
      const htmlAttrs = htmlMatch[1];
      if (!htmlAttrs.includes(`className={${fontObjectIdentifier}.className}`)) {
        // className이 이미 있는지 확인
        const classNameMatch = htmlAttrs.match(/className\s*=\s*\{([^}]+)\}/);
        if (classNameMatch) {
          // 기존 className에 추가
          const newClassName = `className={${classNameMatch[1]} + " " + ${fontObjectIdentifier}.className}`;
          layoutContent = layoutContent.replace(htmlTagPattern, `<html ${newClassName}>`);
        } else {
          // 새로운 className 추가
          layoutContent = layoutContent.replace(htmlTagPattern, `<html className={${fontObjectIdentifier}.className}${htmlAttrs}>`);
        }
      }
    }
  }
  // Local Font인 경우
  else if (fontConfig.type === 'local') {
    const fontFamilyName = fontConfig.fontFamilyName;
    const fontFilePath = fontConfig.fontFilePath;
    const fontWeight = fontConfig.fontWeight;
    const fontStyle = fontConfig.fontStyle;
    const fontObjectIdentifier = 'localFont';

    // import 문 추가 (이미 존재하는지 확인)
    const importPattern = /import\s+localFont\s+from\s+["']next\/font\/local["']/;
    if (!importPattern.test(layoutContent)) {
      // 첫 번째 import 문 앞에 추가
      const firstImportMatch = layoutContent.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        layoutContent = layoutContent.slice(0, insertIndex) +
          `import localFont from "next/font/local";\n` +
          layoutContent.slice(insertIndex);
      } else {
        layoutContent = `import localFont from "next/font/local";\n` + layoutContent;
      }
    }

    // 폰트 객체 생성 (이미 존재하는지 확인)
    const fontObjectPattern = /const\s+localFont\s*=\s*localFont\(/;
    if (!fontObjectPattern.test(layoutContent)) {
      // import 문 다음에 추가
      const lastImportMatch = layoutContent.match(/^import\s+[^;]+;?\s*\n/m);
      if (lastImportMatch) {
        const insertIndex = lastImportMatch.index + lastImportMatch[0].length;
        layoutContent = layoutContent.slice(0, insertIndex) +
          `\nconst ${fontObjectIdentifier} = localFont({\n` +
          `  src: [{\n` +
          `    path: "${fontFilePath}",\n` +
          `    weight: "${fontWeight}",\n` +
          `    style: "${fontStyle}",\n` +
          `  }],\n` +
          `  display: "swap",\n` +
          `});\n` +
          layoutContent.slice(insertIndex);
      }
    }

    // <html> 태그에 className 추가
    const htmlTagPattern = /<html([^>]*)>/;
    const htmlMatch = layoutContent.match(htmlTagPattern);
    if (htmlMatch) {
      const htmlAttrs = htmlMatch[1];
      if (!htmlAttrs.includes(`className={${fontObjectIdentifier}.className}`)) {
        // className이 이미 있는지 확인
        const classNameMatch = htmlAttrs.match(/className\s*=\s*\{([^}]+)\}/);
        if (classNameMatch) {
          // 기존 className에 추가
          const newClassName = `className={${classNameMatch[1]} + " " + ${fontObjectIdentifier}.className}`;
          layoutContent = layoutContent.replace(htmlTagPattern, `<html ${newClassName}>`);
        } else {
          // 새로운 className 추가
          layoutContent = layoutContent.replace(htmlTagPattern, `<html className={${fontObjectIdentifier}.className}${htmlAttrs}>`);
        }
      }
    }
  }

  await fs.writeFile(layoutPath, layoutContent, 'utf-8');
}

module.exports = {
  applyNextFont,
};

