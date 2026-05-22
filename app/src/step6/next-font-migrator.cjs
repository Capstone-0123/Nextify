// src/step6/next-font-migrator.cjs
// next/font 적용

const fs = require('fs-extra');
const path = require('path');
const { stopAndOfferGeminiApply } = require('../utils/manual-flow.cjs');

function relFromRoot(projectRoot, absPath) {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

function collectFontAiCandidates(projectRoot, primaryRel) {
  const set = new Set([primaryRel]);
  const extras = [
    'src/app/layout.tsx',
    'src/app/globals.css',
    'src/app/global.css',
    'src/index.html',
    'src/App.css',
    'index.html',
  ];
  for (const e of extras) {
    if (fs.existsSync(path.join(projectRoot, e))) set.add(e);
  }
  return [...set];
}

//=========================================================
// next/font 적용 메인 함수
//=========================================================
async function applyNextFont(projectRoot) {
  // Case d 체크: Gemini 자동 수정이 필요한지 확인
  await checkManualProcessingCases(projectRoot);

  // Case a0: step2가 index.html head를 layout.tsx JSX로 복사한 뒤에는 링크가 layout에만 있음
  await migrateGoogleFontsFromLayoutTsx(projectRoot);

  // Case a: index.html / src/index.html에서 Google Fonts <link>를 사용하는 경우
  await migrateGoogleFontsFromIndexHtml(projectRoot);
  await migrateGoogleFontsFromRootIndexHtml(projectRoot);

  // Case b: CSS @import로 Google Fonts를 사용하는 경우
  await migrateGoogleFontsFromCssImport(projectRoot);

  // Case c: 로컬 폰트 파일을 CSS @font-face로 사용하는 경우
  await migrateLocalFontsFromFontFace(projectRoot);
}

//=========================================================
// Case d: Gemini 자동 수정이 필요한 경우 체크
//=========================================================
async function checkManualProcessingCases(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const publicDir = path.join(projectRoot, 'public');

  // 3. CSS 변수(--font-...) 또는 font-family fallback 체인이 복잡하게 구성된 경우
  const cssFiles = [
    path.join(srcDir, 'index.css'),
    path.join(srcDir, 'app', 'globals.css'),
    path.join(srcDir, 'app', 'global.css'),
    path.join(srcDir, 'App.css'),
  ].filter(filePath => fs.existsSync(filePath));

  for (const cssFilePath of cssFiles) {
    const cssContent = await fs.readFile(cssFilePath, 'utf-8');
    
    // CSS 변수 사용 체크
    if (cssContent.includes('--font-') && cssContent.match(/font-family\s*:\s*var\(--font-[^)]+\)/g)) {
      const rel = relFromRoot(projectRoot, cssFilePath);
      await stopAndOfferGeminiApply({
        projectRoot,
        discoveryLine:
          'CSS 변수(--font-...) 또는 font-family fallback 체인이 복잡하게 구성된 스타일이 발견되었습니다.',
        discoverySources: [rel],
        instructionForAi: `Next.js App Router로 마이그레이션합니다. ${rel} 및 layout에서 --font- CSS 변수와 font-family를 next/font 패턴에 맞게 수정하세요.`,
        candidateRelPaths: collectFontAiCandidates(projectRoot, rel),
      });
      return;
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
      const rel = relFromRoot(projectRoot, filePath);
      await stopAndOfferGeminiApply({
        projectRoot,
        discoveryLine: 'FontFace API로 동적 폰트를 로드하는 코드가 발견되었습니다.',
        discoverySources: [rel],
        instructionForAi: `Next.js에서 ${rel}의 FontFace 사용을 next/font/local 기반으로 바꾸세요.`,
        candidateRelPaths: collectFontAiCandidates(projectRoot, rel),
      });
      return;
    }

    if (content.includes('document.fonts.load') || content.includes('fonts.load(')) {
      const rel = relFromRoot(projectRoot, filePath);
      await stopAndOfferGeminiApply({
        projectRoot,
        discoveryLine: 'document.fonts.load 등으로 동적 폰트를 로드하는 코드가 발견되었습니다.',
        discoverySources: [rel],
        instructionForAi: `Next.js에서 ${rel}의 fonts.load 사용을 next/font/local 기반으로 바꾸세요.`,
        candidateRelPaths: collectFontAiCandidates(projectRoot, rel),
      });
      return;
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
            const rel = relFromRoot(projectRoot, htmlPath);
            await stopAndOfferGeminiApply({
              projectRoot,
              discoveryLine: 'Google Fonts가 아닌 외부 CDN 폰트 링크가 발견되었습니다.',
              discoverySources: [rel],
              instructionForAi: `Next.js로 마이그레이션합니다. ${rel}의 외부 폰트 링크를 next/font/local 또는 적절한 next/font 사용으로 바꾸세요.`,
              candidateRelPaths: collectFontAiCandidates(projectRoot, rel),
            });
            return;
          }
        }
      }
    }
  }
}

/**
 * Google Fonts css2 URL에서 family 목록을 파싱합니다 (family= 파라미터 반복 형식).
 * @returns {Array<{ fontFamilyIdentifier: string, weightList: number[], displayOption: string }>|null}
 */
function parseGoogleFontsCss2Href(href) {
  try {
    const u = new URL(href, 'https://fonts.googleapis.com');
    if (!/fonts\.googleapis\.com$/i.test(u.hostname)) return null;
    const rawFamilies = u.searchParams.getAll('family');
    if (!rawFamilies.length) return null;
    const displayOption = u.searchParams.get('display') || 'swap';
    const out = [];
    for (const raw of rawFamilies) {
      let namePart = raw;
      let wghtPart = null;
      const colonIdx = raw.indexOf(':');
      if (colonIdx !== -1) {
        namePart = raw.slice(0, colonIdx);
        const axis = raw.slice(colonIdx + 1);
        const wghtMatch = axis.match(/^wght@(.+)$/i);
        if (wghtMatch) wghtPart = wghtMatch[1];
      }
      const weightList = wghtPart
        ? wghtPart
            .split(/[;]/)
            .map((w) => parseInt(String(w).trim(), 10))
            .filter((n) => !Number.isNaN(n))
        : [];
      const fontFamilyIdentifier = namePart
        .replace(/\+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
      if (!fontFamilyIdentifier) continue;
      out.push({
        fontFamilyIdentifier,
        weightList: weightList.length ? weightList : [400],
        displayOption,
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function stripGoogleFontLinkTags(htmlOrJsx) {
  return htmlOrJsx.replace(/<link[^>]*(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*\/?>/gi, '');
}

//=========================================================
// Case a0: src/app/layout.tsx 안의 Google Fonts <link> (step2가 index.html head를 JSX로 복사한 경우)
//=========================================================
async function migrateGoogleFontsFromLayoutTsx(projectRoot) {
  const layoutPath = path.join(projectRoot, 'src', 'app', 'layout.tsx');
  if (!fs.existsSync(layoutPath)) return;

  let layoutContent = await fs.readFile(layoutPath, 'utf-8');
  const original = layoutContent;

  const googleFontsLinkPattern = /<link\s+[^>]*(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*\/?>/gi;
  const googleFontsLinks = layoutContent.match(googleFontsLinkPattern);
  if (!googleFontsLinks || googleFontsLinks.length === 0) {
    return;
  }

  let css2Href = null;
  for (const linkTag of googleFontsLinks) {
    const css2Match = linkTag.match(/href=["']([^"']*fonts\.googleapis\.com\/css2[^"']*)["']/i);
    if (css2Match) {
      css2Href = css2Match[1];
      break;
    }
  }

  if (!css2Href) {
    layoutContent = stripGoogleFontLinkTags(layoutContent);
    layoutContent = layoutContent.replace(/\n\s*\n\s*\n/g, '\n\n');
    if (layoutContent !== original) {
      await fs.writeFile(layoutPath, layoutContent, 'utf-8');
    }
    return;
  }

  const parsedFamilies = parseGoogleFontsCss2Href(css2Href);
  if (!parsedFamilies) {
    const rel = relFromRoot(projectRoot, layoutPath);
    await stopAndOfferGeminiApply({
      projectRoot,
      discoveryLine: 'layout.tsx의 Google Fonts css2 링크를 자동 파싱하지 못했습니다.',
      discoverySources: [rel],
      instructionForAi: `${rel}의 Google Fonts <link>를 next/font/google로 옮기고, preconnect/stylesheet 링크는 제거하세요.`,
      candidateRelPaths: collectFontAiCandidates(projectRoot, rel),
    });
    return;
  }

  for (const fam of parsedFamilies) {
    // eslint-disable-next-line no-await-in-loop
    await addFontToLayout(projectRoot, {
      type: 'google',
      fontFamilyIdentifier: fam.fontFamilyIdentifier,
      weightList: fam.weightList,
      displayOption: fam.displayOption,
    });
  }

  layoutContent = await fs.readFile(layoutPath, 'utf-8');
  layoutContent = stripGoogleFontLinkTags(layoutContent);
  layoutContent = layoutContent.replace(/\n\s*\n\s*\n/g, '\n\n');
  await fs.writeFile(layoutPath, layoutContent, 'utf-8');
}

//=========================================================
// Case a: index.html에서 Google Fonts <link>를 사용하는 경우
//=========================================================
async function migrateGoogleFontsFromIndexHtml(projectRoot) {
  const indexHtmlPath = path.join(projectRoot, 'src', 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    return;
  }
  await migrateGoogleFontsFromHtmlFile(projectRoot, indexHtmlPath);
}

//=========================================================
// Case a': 프로젝트 루트 index.html (Vite 기본)
//=========================================================
async function migrateGoogleFontsFromRootIndexHtml(projectRoot) {
  const indexHtmlPath = path.join(projectRoot, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    return;
  }
  await migrateGoogleFontsFromHtmlFile(projectRoot, indexHtmlPath);
}

async function migrateGoogleFontsFromHtmlFile(projectRoot, indexHtmlPath) {
  const htmlContent = await fs.readFile(indexHtmlPath, 'utf-8');

  const googleFontsLinkPattern = /<link\s+[^>]*(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>/gi;
  const googleFontsLinks = htmlContent.match(googleFontsLinkPattern);

  if (!googleFontsLinks || googleFontsLinks.length === 0) {
    return;
  }

  let css2Href = null;
  for (const linkTag of googleFontsLinks) {
    const css2Match = linkTag.match(/href=["']([^"']*fonts\.googleapis\.com\/css2[^"']*)["']/i);
    if (css2Match) {
      css2Href = css2Match[1];
      break;
    }
  }

  if (!css2Href) {
    let newHtmlContent = stripGoogleFontLinkTags(htmlContent);
    newHtmlContent = newHtmlContent.replace(/\n\s*\n\s*\n/g, '\n\n');
    if (newHtmlContent !== htmlContent) {
      await fs.writeFile(indexHtmlPath, newHtmlContent, 'utf-8');
    }
    return;
  }

  const parsedFamilies = parseGoogleFontsCss2Href(css2Href);
  if (!parsedFamilies) {
    const rel = relFromRoot(projectRoot, indexHtmlPath);
    await stopAndOfferGeminiApply({
      projectRoot,
      discoveryLine: 'Google Fonts css2 링크를 자동 파싱하지 못했습니다.',
      discoverySources: [rel],
      instructionForAi: `${rel}의 Google Fonts를 next/font/google로 옮기고 layout에 반영한 뒤 링크를 제거하세요.`,
      candidateRelPaths: collectFontAiCandidates(projectRoot, rel),
    });
    return;
  }

  for (const fam of parsedFamilies) {
    // eslint-disable-next-line no-await-in-loop
    await addFontToLayout(projectRoot, {
      type: 'google',
      fontFamilyIdentifier: fam.fontFamilyIdentifier,
      weightList: fam.weightList,
      displayOption: fam.displayOption,
    });
  }

  let newHtmlContent = stripGoogleFontLinkTags(htmlContent);
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
    path.join(appDir, 'global.css'),
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

    let parsedFamilies = null;
    for (const importMatch of importMatches) {
      const urlMatch = importMatch.match(/url\(["']([^"']+)["']\)/);
      if (!urlMatch) continue;
      const href = urlMatch[1];
      parsedFamilies = parseGoogleFontsCss2Href(href);
      if (parsedFamilies) break;
    }

    if (!parsedFamilies) {
      const rel = relFromRoot(projectRoot, cssFilePath);
      await stopAndOfferGeminiApply({
        projectRoot,
        discoveryLine: 'CSS @import Google Fonts를 자동 파싱하지 못했습니다.',
        discoverySources: [rel],
        instructionForAi: `${rel}의 @import Google Fonts를 next/font/google로 옮기고 CSS를 정리하세요.`,
        candidateRelPaths: collectFontAiCandidates(projectRoot, rel),
      });
      return;
    }

    for (const fam of parsedFamilies) {
      // eslint-disable-next-line no-await-in-loop
      await addFontToLayout(projectRoot, {
        type: 'google',
        fontFamilyIdentifier: fam.fontFamilyIdentifier,
        weightList: fam.weightList,
        displayOption: fam.displayOption,
      });
    }

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
    path.join(srcDir, 'app', 'global.css'),
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

    // 여러 @font-face 선언이 하나의 font-family로 묶여 있는 경우 Gemini 제안
    const fontFamilyNames = new Set();
    for (const fontFace of fontFaceMatches) {
      const familyMatch = fontFace.match(/font-family\s*:\s*["']?([^"';}]+)["']?/i);
      if (familyMatch) {
        fontFamilyNames.add(familyMatch[1].trim());
      }
    }

    if (fontFamilyNames.size === 1 && fontFaceMatches.length > 1) {
      const rel = relFromRoot(projectRoot, cssFilePath);
      await stopAndOfferGeminiApply({
        projectRoot,
        discoveryLine: '동일 font-family에 @font-face 선언이 여러 개 묶여 있는 CSS가 발견되었습니다.',
        discoverySources: [rel],
        instructionForAi: `${rel}의 @font-face들을 next/font/local 한 번으로 정리하고 layout/className을 맞추세요.`,
        candidateRelPaths: collectFontAiCandidates(projectRoot, rel),
      });
      return;
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

/**
 * 첫 번째 non-import 코드 직전까지를 import 블록으로 보고, 그 끝 인덱스를 반환합니다.
 */
function findInsertIndexAfterImportBlock(content) {
  const lines = content.split(/\r?\n/);
  let lastImportEnd = -1;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^import\s/.test(trimmed)) {
      lastImportEnd = offset + line.length;
      if (i < lines.length - 1) lastImportEnd += 1; // newline
    } else if (lastImportEnd >= 0) {
      if (trimmed === '' || trimmed.startsWith('//')) {
        lastImportEnd = offset + line.length;
        if (i < lines.length - 1) lastImportEnd += 1;
      } else {
        break;
      }
    }
    offset += line.length + 1;
  }
  return lastImportEnd >= 0 ? lastImportEnd : 0;
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
      // next/font/google 의 weight 옵션은 OneOrManyStrings 타입입니다.
      // 숫자 배열 ([300, 400]) 을 그대로 출력하면 Turbopack 빌드가
      //   "data did not match any variant of untagged enum OneOrManyStrings"
      // 로 실패하므로, 각 weight 를 문자열 리터럴로 감쌉니다.
      const weightLiteral = weightList.length === 1
        ? `"${weightList[0]}"`
        : `[${weightList.map((w) => `"${w}"`).join(', ')}]`;

      const insertIndex = findInsertIndexAfterImportBlock(layoutContent);
      layoutContent = layoutContent.slice(0, insertIndex) +
        (insertIndex > 0 && layoutContent.slice(insertIndex - 1, insertIndex) !== '\n' ? '\n' : '') +
        `const ${fontObjectIdentifier} = ${fontFamilyIdentifier}({\n` +
        `  subsets: ["latin"],\n` +
        `  weight: ${weightLiteral},\n` +
        `  display: "${displayOption}",\n` +
        `});\n` +
        layoutContent.slice(insertIndex);
    }

    // <html> 태그에 className 추가 (멱등)
    //
    // 기존 검사 `htmlAttrs.includes('className={<id>.className}')` 는 부분 문자열
    // 매칭이라 같은 폰트가 다른 위치 (link / @import / index.html) 에서 여러 번
    // 검출되면 className 이 누적 추가되어 다음과 같은 결과가 나옵니다:
    //   className={interFont.className + " " + robotoFont.className + " " + interFont.className + " " + robotoFont.className}
    // 따라서 멱등성은 `${id}.className` 식별자가 className 값 표현식 안에
    // 이미 등장하는지로 판단합니다.
    const htmlTagPattern = /<html([^>]*)>/;
    const htmlMatch = layoutContent.match(htmlTagPattern);
    if (htmlMatch) {
      const htmlAttrs = htmlMatch[1];
      const fontClassRef = `${fontObjectIdentifier}.className`;
      const classNameMatch = htmlAttrs.match(/className\s*=\s*\{([^}]+)\}/);
      const existingClassNameExpr = classNameMatch ? classNameMatch[1] : '';

      if (!existingClassNameExpr.includes(fontClassRef)) {
        if (classNameMatch) {
          const newClassName = `className={${existingClassNameExpr} + " " + ${fontClassRef}}`;
          layoutContent = layoutContent.replace(htmlTagPattern, `<html ${htmlAttrs.replace(classNameMatch[0], newClassName)}>`);
        } else {
          layoutContent = layoutContent.replace(htmlTagPattern, `<html className={${fontClassRef}}${htmlAttrs}>`);
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
      const insertIndex = findInsertIndexAfterImportBlock(layoutContent);
      layoutContent = layoutContent.slice(0, insertIndex) +
        (insertIndex > 0 && layoutContent.slice(insertIndex - 1, insertIndex) !== '\n' ? '\n' : '') +
        `const ${fontObjectIdentifier} = localFont({\n` +
        `  src: [{\n` +
        `    path: "${fontFilePath}",\n` +
        `    weight: "${fontWeight}",\n` +
        `    style: "${fontStyle}",\n` +
        `  }],\n` +
        `  display: "swap",\n` +
        `});\n` +
        layoutContent.slice(insertIndex);
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

