// src/step7/next-image-migrator.cjs
// next/image 적용

const fs = require('fs-extra');
const path = require('path');
const { stopAndOfferGeminiApply } = require('../utils/manual-flow.cjs');
const { loadNextifyProjectConfig } = require('../utils/nextify-project-config.cjs');

function toRel(projectRoot, absPath) {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

/**
 * 외부 HTTPS URL이 이미지일 가능성. 프로젝트 전용 호스트는 `.nextify` 설정 `imageUrlHostHints`.
 */
function isLikelyRasterImageUrl(url, extraHostHints = []) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|#|$)/i.test(url)) return true;
  if (
    /(?:^|\/)image|img\/|images\/|cdn|cloudinary|unsplash|twimg|placeholder|static\.|assets?\.|media\.|blob\.core/i.test(
      url,
    )
  ) {
    return true;
  }
  const lower = url.toLowerCase();
  for (const h of extraHostHints) {
    if (h && lower.includes(String(h).toLowerCase())) return true;
  }
  return false;
}

/**
 * CSS 내 url("https://...") / url('https://...') / url(https://...) 에서 외부 이미지 URL을 수집합니다.
 */
function collectUrlsFromCssText(cssText, extraHostHints = []) {
  const urls = [];
  const re = /url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const u = m[2];
    if (isLikelyRasterImageUrl(u, extraHostHints)) urls.push(u);
  }
  return urls;
}

function tsxPathMatchesGeminiSubdirs(filePathPosix, subdirs) {
  const n = String(filePathPosix).replace(/\\/g, '/');
  return subdirs.some((sd) => {
    const norm = sd.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    return n.includes(`/${norm}/`);
  });
}

function shouldAugmentLcpForImageAttrs(attrs, relPath, lcpBaseNames) {
  if (/\bpriority\b/.test(attrs)) return false;
  if (/\bloading\s*=\s*["']lazy["']/.test(attrs)) return false;
  const base = path.basename(relPath, path.extname(relPath));
  if (lcpBaseNames.some((b) => b === base)) return true;
  if (/heroBg|heroImage|HeroBanner|backdrop|bannerBg|fullBleed/i.test(attrs)) return true;
  return false;
}

function attrsLookLikeRemoteHeroSrc(attrs) {
  if (/src\s*=\s*["']https?:\/\//.test(attrs)) return true;
  if (/src\s*=\s*\{[^}]*getImageUrl/.test(attrs)) return true;
  if (/src\s*=\s*\{[A-Za-z_][A-Za-z0-9_]*\}/.test(attrs)) return true;
  return false;
}

function buildLcpImageAttrString(trimmedInner) {
  const parts = [];
  if (!/\bpriority\b/.test(trimmedInner)) parts.push('priority');
  if (!/\bsizes\s*=/.test(trimmedInner)) parts.push('sizes="100vw"');
  if (!/\bfetchPriority\s*=/.test(trimmedInner)) parts.push('fetchPriority="high"');
  const prefix = parts.join(' ');
  if (!prefix) return trimmedInner;
  return prefix + (trimmedInner ? ' ' + trimmedInner : '');
}

async function enhanceNextImageTagsForLcp(projectRoot, filePath, nextifyConfig) {
  const rel = toRel(projectRoot, filePath);
  if (!/\.(tsx|jsx)$/.test(rel)) return;
  let content = await fs.readFile(filePath, 'utf-8');
  if (!/next\/image/.test(content)) return;

  const re = /<Image([\s\S]*?)\/>/g;
  const matches = [...content.matchAll(re)];
  let out = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const inner = match[1];
    const full = match[0];
    const trimmed = inner.trim();
    if (!shouldAugmentLcpForImageAttrs(trimmed, rel, nextifyConfig.lcpImageFilenameBaseNames)) {
      continue;
    }
    if (!attrsLookLikeRemoteHeroSrc(trimmed)) continue;
    const built = buildLcpImageAttrString(trimmed);
    if (built === trimmed) continue;
    const newTag = '<Image ' + built + ' />';
    out = out.slice(0, match.index) + newTag + out.slice(match.index + full.length);
  }
  if (out !== content) await fs.writeFile(filePath, out, 'utf-8');
}

/**
 * LCP 후보 파일명(lcpImageFilenameBaseNames)에서 next/image + priority 원격 src 는
 * `/_next/image` 홉 없이 브라우저가 CDN 직접 요청하도록 네이티브 <img> 로 바꿉니다.
 */
function stripUnusedNextImageImport(content) {
  if (/<Image[\s>/]/.test(content)) return content;
  return content
    .replace(/^import\s+Image\s*,\s*\{[^}]+\}\s+from\s+["']next\/image["'];?\s*\r?\n?/m, '')
    .replace(/^import\s+\{[^}]+\}\s*,\s*Image\s+from\s+["']next\/image["'];?\s*\r?\n?/m, '')
    .replace(/^import\s+Image\s+from\s+["']next\/image["'];?\s*\r?\n?/m, '')
    .replace(/\nimport\s+Image\s+from\s+["']next\/image["'];?\s*\r?\n?/g, '\n');
}

function convertHeroFillImageToNative(content) {
  const re = /<Image\s+([\s\S]*?)\/>/g;
  return content.replace(re, (full, inner) => {
    const t = inner.trim();
    if (!/\bfill\b/.test(t) || !/\bpriority\b/.test(t)) return full;
    if (!/src\s*=\s*\{[^}]*getImageUrl\s*\(/.test(t)) return full;

    let srcM = t.match(/src\s*=\s*(\{getImageUrl\([^)]+\)\})/);
    if (!srcM) srcM = t.match(/src\s*=\s*(\{[^}]+\})/);
    if (!srcM) return full;
    const srcExpr = srcM[1];

    const altM = t.match(/alt\s*=\s*(\{[^}]+\}|["'][^"']*["'])/);
    const altPart = altM ? `alt=${altM[1]}` : 'alt=""';

    return (
      `<img\n        src=${srcExpr}\n        ${altPart}\n        loading="eager"\n        fetchPriority="high"\n        decoding="async"\n        className="absolute inset-0 z-0 h-full w-full object-cover object-center"\n      />`
    );
  });
}

function constDeclaresHttpsUrlForVar(content, varName) {
  const re = new RegExp(
    `\\bconst\\s+${varName.replace(/[^A-Za-z0-9_]/g, '')}\\s*=\\s*(["'])(https?:\\/\\/[^"']+)\\1`,
  );
  return re.test(content);
}

function convertLiteralOrConstPriorityImageToNative(content) {
  const re = /<Image\s+([\s\S]*?)\/>/g;
  return content.replace(re, (full, inner) => {
    const t = inner.trim();
    if (!/\bpriority\b/.test(t)) return full;
    if (/\bfill\b/.test(t)) return full;

    let srcPart = '';
    const litD = t.match(/src\s*=\s*"([^"]+)"/);
    if (litD && /^https?:\/\//i.test(litD[1])) {
      srcPart = `src="${litD[1]}"`;
    } else {
      const litS = t.match(/src\s*=\s*'([^']+)'/);
      if (litS && /^https?:\/\//i.test(litS[1])) {
        srcPart = `src='${litS[1]}'`;
      } else {
        const br = t.match(/src\s*=\s*\{([A-Za-z_][A-Za-z0-9_]*)\}/);
        if (!br) return full;
        const varName = br[1];
        if (!constDeclaresHttpsUrlForVar(content, varName)) return full;
        srcPart = `src={${varName}}`;
      }
    }

    const clsM = t.match(/className\s*=\s*(\{[^}]+\}|["'][^"']*["'])/);
    const classPart = clsM ? ` className=${clsM[1]}` : '';

    const altM = t.match(/alt\s*=\s*(\{[^}]+\}|["'][^"']*["'])/);
    const altPart = altM ? ` alt=${altM[1]}` : ' alt=""';

    return `<img ${srcPart}${classPart}${altPart} loading="eager" fetchPriority="high" decoding="async" />`;
  });
}

async function convertLcpNamedFilesRemotePriorityImageToNative(projectRoot, filePath, nextifyConfig) {
  const rel = toRel(projectRoot, filePath);
  if (!/\.(tsx|jsx)$/.test(rel)) return;
  const base = path.basename(rel, path.extname(rel));
  if (!nextifyConfig.lcpImageFilenameBaseNames.some((b) => b === base)) return;

  let content = await fs.readFile(filePath, 'utf-8');
  if (!/next\/image/.test(content) || !/<Image\s/.test(content)) return;
  const original = content;

  if (base === 'Hero') {
    content = convertHeroFillImageToNative(content);
  }
  if (base === 'Home' || base === 'Banner' || base === 'Landing') {
    content = convertLiteralOrConstPriorityImageToNative(content);
  }

  if (content !== original) {
    content = stripUnusedNextImageImport(content);
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

async function maybeMigrateInlineBackgroundImagesWithAi(projectRoot, srcDir, findTsFiles, nextifyConfig) {
  const files = await findTsFiles(srcDir);
  const hitRels = [];
  for (const fp of files) {
    if (!/\.(tsx|jsx)$/.test(fp)) continue;
    let c;
    try {
      c = await fs.readFile(fp, 'utf-8');
    } catch {
      continue;
    }
    if (!/backgroundImage\s*:/.test(c)) continue;
    const idx = c.indexOf('backgroundImage');
    const slice = c.slice(idx, idx + 500);
    if (!/https?:\/\/|getImageUrl/.test(slice)) continue;
    hitRels.push(toRel(projectRoot, fp));
  }
  const uniq = [...new Set(hitRels)];
  if (uniq.length === 0) return;

  const allTsx = await findTsFiles(srcDir);
  const tsxCandidates = allTsx
    .filter((p) => tsxPathMatchesGeminiSubdirs(toRel(projectRoot, p), nextifyConfig.geminiTsxSubdirs))
    .map((p) => toRel(projectRoot, p));
  const allCss = await findCssFiles(srcDir);
  const cssCandidates = allCss
    .filter((p) => tsxPathMatchesGeminiSubdirs(toRel(projectRoot, p), nextifyConfig.geminiTsxSubdirs))
    .map((p) => toRel(projectRoot, p));

  const candidateRelPaths = [
    ...uniq,
    'src/app/layout.tsx',
    ...tsxCandidates,
    ...cssCandidates,
  ].filter((rel, idx, arr) => arr.indexOf(rel) === idx && fs.existsSync(path.join(projectRoot, rel)));

  await stopAndOfferGeminiApply({
    projectRoot,
    discoveryLine: `JSX style.backgroundImage( url / getImageUrl ) 패턴이 ${uniq.length}개 파일에서 감지되었습니다. next/image + fill + priority 로 바꾸면 LCP가 좋아집니다.`,
    discoverySources: uniq.slice(0, 15),
    instructionForAi: `Next.js App Router step7 LCP 작업입니다.

[목표]
- style={{ backgroundImage: \`url(...)\` }} 등으로 깔린 큰 원격 이미지는 LCP 후보로 부적절합니다.
- next/image 로 바꿉니다: fill, priority, sizes="100vw", fetchPriority="high", alt="" 또는 의미 있는 alt
- 부모 section 은 position:relative 및 높이 유지, 그라데이션은 Image 위 레이어(z-index)로 유지

[금지]
- next.config.mjs / js / ts 변경 (이미지 호스트는 도구가 추가함)
- API/라우트/비즈니스 로직 변경

[출력] 화이트리스트에 포함된 파일만 수정.`,
    candidateRelPaths: candidateRelPaths.slice(0, 48),
  });
}

async function findCssFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (!['node_modules', '.next', '.git', 'dist', 'build'].includes(item.name)) {
        files.push(...(await findCssFiles(fullPath)));
      }
    } else if (/\.(css|module\.css)$/.test(item.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

//=========================================================
// next/image 적용 메인 함수
//=========================================================
async function applyNextImage(projectRoot) {
  const nextifyConfig = loadNextifyProjectConfig(projectRoot);
  const imageUrlHints = nextifyConfig.imageUrlHostHints;

  const srcDir = path.join(projectRoot, 'src');
  
  // src/ 디렉터리가 존재하지 않으면 종료
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // 수집된 이미지 URL에서 호스트네임 추출
  const imageUrls = new Set();

  // 1. src/ 디렉터리 하위 .ts, .tsx 파일 찾기
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

  // 파일 내 <img> 태그를 <Image> 태그로 변환
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;
    
    // 이미지 URL 수집 (next.config.mjs 업데이트용)
    const fileImageUrls = [];

    // 2. JSX 내부에서 <img ... /> 또는 <img ... > 태그 찾기
    // 여러 줄에 걸친 태그도 처리할 수 있도록 개선
    // 단, 다른 태그의 속성 안에 포함되지 않도록 주의
    const imgTagPattern = /<img\s+([\s\S]*?)(?:\s*\/>|>)/g;
    const imgTags = [];
    let match;

    while ((match = imgTagPattern.exec(content)) !== null) {
      const fullMatch = match[0];
      const attributes = match[1];
      const tagIndex = match.index;
      
      // 태그 앞뒤 문맥 확인 (다른 태그의 속성 안에 잘못 포함되지 않았는지)
      const beforeTag = content.slice(Math.max(0, tagIndex - 50), tagIndex);
      const afterTag = content.slice(tagIndex + fullMatch.length, tagIndex + fullMatch.length + 10);
      
      // 다른 태그의 속성 안에 포함된 경우 건너뛰기
      // 예: <div className="...<img..."> 같은 경우
      let isInsideAttribute = false;
      
      // 앞쪽에서 열린 따옴표나 중괄호가 닫히지 않았는지 확인
      const beforeContext = beforeTag;
      const openQuotes = (beforeContext.match(/["']/g) || []).length;
      const closeQuotes = (beforeContext.match(/["']/g) || []).length;
      
      // className="..." 안에 있는지 확인
      const classNameMatch = beforeContext.match(/className\s*=\s*["']([^"']*)$/);
      if (classNameMatch) {
        // className 속성 값이 아직 닫히지 않았으면 건너뛰기
        isInsideAttribute = true;
      }
      
      // style={{...}} 안에 있는지 확인
      const styleMatch = beforeContext.match(/style\s*=\s*\{\s*\{/);
      if (styleMatch) {
        // 중괄호가 제대로 닫혔는지 확인
        const openBraces = (beforeContext.match(/\{/g) || []).length;
        const closeBraces = (beforeContext.match(/\}/g) || []).length;
        if (openBraces > closeBraces) {
          isInsideAttribute = true;
        }
      }
      
      if (isInsideAttribute) {
        continue;
      }
      
      // 태그가 제대로 닫혀있는지 확인
      if (!fullMatch.endsWith('/>') && !fullMatch.endsWith('>')) {
        continue;
      }
      
      imgTags.push({
        fullMatch: fullMatch,
        attributes: attributes.trim(),
        index: tagIndex,
      });
      
      // src 속성에서 URL 추출 (이미지 호스트네임 수집용)
      const srcMatch = attributes.match(/src\s*=\s*(["'])([^"']*)\1|src\s*=\s*\{([^}]+)\}/);
      if (srcMatch) {
        const url = srcMatch[2] || srcMatch[3];
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
          fileImageUrls.push(url.trim());
        }
      }
    }

    // 파일 전체에서 이미지 URL 추출 (함수 호출 등 포함)
    // 예: getImageUrl(), "https://...", 'https://...' 등
    const urlPattern = /(?:https?:\/\/[^\s"'`\)]+)/g;
    let urlMatch;
    while ((urlMatch = urlPattern.exec(content)) !== null) {
      const url = urlMatch[0];
      if (isLikelyRasterImageUrl(url, imageUrlHints)) {
        fileImageUrls.push(url);
      }
    }

    // <img> 태그가 없으면 URL만 수집하고 종료
    if (imgTags.length === 0) {
      return fileImageUrls;
    }

    // 3. next/image import 존재 여부 확인
    const nextImageImportPattern = /import\s+Image\s+from\s+["']next\/image["'];?\s*\n?/;
    const hasNextImageImport = nextImageImportPattern.test(content);

    // 4. 존재하지 않으면 파일 최상단에 import Image from "next/image"; 추가
    const importLine = 'import Image from "next/image";\n';
    if (!hasNextImageImport) {
      const firstImportMatch = content.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        content =
          content.slice(0, insertIndex) + importLine + content.slice(insertIndex);
        const delta = importLine.length;
        for (const tag of imgTags) {
          if (tag.index >= insertIndex) tag.index += delta;
        }
      } else {
        content = importLine + content;
        const delta = importLine.length;
        for (const tag of imgTags) {
          tag.index += delta;
        }
      }
    }

    // 5. <img> 태그를 <Image> 태그로 변경 (역순으로 처리하여 인덱스 변경 방지)
    for (let i = imgTags.length - 1; i >= 0; i--) {
      const imgTag = imgTags[i];
      const newTag = convertImgToImage(imgTag.attributes);
      
      // 전체 태그를 교체
      content = content.slice(0, imgTag.index) + 
                newTag + 
                content.slice(imgTag.index + imgTag.fullMatch.length);
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
    
    // 수집된 이미지 URL 반환
    return fileImageUrls;
  }

  /**
   * loading="eager" / fetchPriority="high" → next/image priority (프로젝트 공통 LCP 힌트).
   */
  function imgAttrsSuggestLcpPriority(attrMap, attrList) {
    const load = attrMap.loading;
    if (load === 'eager' || load === true) return true;
    const fp = attrMap.fetchPriority || attrMap.fetchpriority;
    if (fp === 'high') return true;
    for (const attr of attrList) {
      if (attr.key === 'loading' && attr.isJSX && /eager/i.test(String(attr.value))) return true;
      if (
        (attr.key === 'fetchPriority' || attr.key === 'fetchpriority') &&
        attr.isJSX &&
        /high/i.test(String(attr.value))
      ) {
        return true;
      }
    }
    return false;
  }

  // <img> 태그를 <Image> 태그로 변환
  function convertImgToImage(attributes) {
    // 속성 파싱 - JSX 속성 형태를 고려
    // key="value", key='value', key={value}, key={...}, key 등 다양한 형태 지원
    const attrMap = {};
    const attrList = [];
    
    // 속성 문자열을 파싱 (더 정교한 파싱)
    let remaining = attributes.trim();
    
    while (remaining.length > 0) {
      // 공백 제거
      remaining = remaining.trim();
      if (remaining.length === 0) break;
      
      // key="value" 또는 key='value' 형태
      const stringValueMatch = remaining.match(/^(\w+)\s*=\s*(["'])([^"']*)\2/);
      if (stringValueMatch) {
        const key = stringValueMatch[1];
        const value = stringValueMatch[3];
        attrMap[key] = value;
        attrList.push({ key, value, isString: true });
        remaining = remaining.slice(stringValueMatch[0].length);
        continue;
      }
      
      // key={value} 형태 (중괄호 내부 처리)
      const jsxValueMatch = remaining.match(/^(\w+)\s*=\s*\{([^}]*)\}/);
      if (jsxValueMatch) {
        const key = jsxValueMatch[1];
        const value = jsxValueMatch[2].trim();
        attrMap[key] = value;
        attrList.push({ key, value, isJSX: true });
        remaining = remaining.slice(jsxValueMatch[0].length);
        continue;
      }
      
      // key만 있는 형태 (boolean 속성)
      const booleanMatch = remaining.match(/^(\w+)(?:\s|$)/);
      if (booleanMatch) {
        const key = booleanMatch[1];
        attrMap[key] = true;
        attrList.push({ key, value: true, isBoolean: true });
        remaining = remaining.slice(booleanMatch[0].length);
        continue;
      }
      
      // 파싱 실패 시 한 문자씩 건너뛰기 (무한 루프 방지)
      remaining = remaining.slice(1);
    }

    // 6. src, alt 속성은 그대로 유지
    // loading / fetchPriority 는 priority 로 승격 가능
    const preservedAttrs = [
      'src',
      'alt',
      'className',
      'style',
      'priority',
      'sizes',
      'width',
      'height',
      'onClick',
      'onLoad',
      'onError',
    ];
    const newAttrs = [];

    const wantPriority =
      imgAttrsSuggestLcpPriority(attrMap, attrList) ||
      attrMap.priority === true ||
      attrMap.priority === '';

    // src 값의 타입 확인 (문자열인지 JSX 표현식인지)
    const srcIsJSX = attrList.find(attr => attr.key === 'src' && attr.isJSX);
    const srcIsString = attrList.find(attr => attr.key === 'src' && attr.isString);

    // 모든 속성 유지 (width, height는 조건부로 처리)
    for (const attr of attrList) {
      const key = attr.key;
      
      // 보존할 속성인지 확인
      if (preservedAttrs.includes(key) || key.startsWith('data-') || key.startsWith('aria-')) {
        if (attr.isBoolean) {
          newAttrs.push(key);
        } else if (attr.isJSX) {
          let value = attr.value;
          
          // alt 속성이 JSX 표현식이고 || 연산자가 포함된 경우 기본값 추가
          if (key === 'alt' && value.includes('||')) {
            // 이미 기본값이 있는지 확인 (|| '...' 또는 || "...")
            const hasDefaultValue = /\|\|\s*["'][^"']+["']/.test(value);
            if (!hasDefaultValue) {
              // 기본값 추가
              value = `${value} || 'Image'`;
            }
          }
          
          newAttrs.push(`${key}={${value}}`);
        } else if (attr.isString) {
          const quote = attr.value.includes('"') ? "'" : '"';
          newAttrs.push(`${key}=${quote}${attr.value}${quote}`);
        }
      }
    }
    
    // alt 속성이 없는 경우 추가
    if (!attrMap.alt) {
      newAttrs.push(`alt="Image"`);
    }

    if (wantPriority && !newAttrs.some((a) => a === 'priority' || a.startsWith('priority '))) {
      newAttrs.unshift('priority');
    }

    // 7.1. src가 로컬 정적 import 변수인 경우 (JSX 표현식)
    // width, height를 새로 추가하지 않음 (정적 import는 Next가 자동 인식)
    // 이미 처리됨 - 아무것도 하지 않음

    // 7.2, 7.3의 경우도 이미 처리됨 (width, height가 없으면 그대로 유지)

    // <Image> 태그 생성
    const attrsString = newAttrs.length > 0 ? ' ' + newAttrs.join(' ') : '';
    return `<Image${attrsString} />`;
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    const urls = await processFile(filePath);
    if (urls && urls.length > 0) {
      urls.forEach((url) => imageUrls.add(url));
    }
  }

  for (const filePath of files) {
    await enhanceNextImageTagsForLcp(projectRoot, filePath, nextifyConfig);
    await convertLcpNamedFilesRemotePriorityImageToNative(projectRoot, filePath, nextifyConfig);
  }

  await maybeMigrateInlineBackgroundImagesWithAi(
    projectRoot,
    srcDir,
    findTsFiles,
    nextifyConfig,
  );

  // CSS background-image / url("https://...") — <img> 마이그레이션만으로는 놓치므로 별도 스캔
  const cssBackgroundRelPaths = [];
  const cssFiles = await findCssFiles(srcDir);
  for (const cssPath of cssFiles) {
    let cssText = '';
    try {
      cssText = await fs.readFile(cssPath, 'utf-8');
    } catch {
      continue;
    }
    const urls = collectUrlsFromCssText(cssText, imageUrlHints);
    if (!urls.length) continue;
    urls.forEach((u) => imageUrls.add(u));
    cssBackgroundRelPaths.push(toRel(projectRoot, cssPath));
  }

  if (cssBackgroundRelPaths.length > 0) {
    const uniqCss = [...new Set(cssBackgroundRelPaths)];
    const allTsx = await findTsFiles(srcDir);
    const tsxCandidates = allTsx
      .filter((p) => tsxPathMatchesGeminiSubdirs(toRel(projectRoot, p), nextifyConfig.geminiTsxSubdirs))
      .map((p) => toRel(projectRoot, p));

    // Gemini 가 같은 페이지의 짝(.module.css) 을 자연스럽게 같이 손볼 수 있도록
    // 일반 소스 트리 하위의 .css/.module.css 를 화이트리스트에 함께 넣습니다.
    const allCss = await findCssFiles(srcDir);
    const cssCandidates = allCss
      .filter((p) => tsxPathMatchesGeminiSubdirs(toRel(projectRoot, p), nextifyConfig.geminiTsxSubdirs))
      .map((p) => toRel(projectRoot, p));

    // next.config.mjs 는 화이트리스트에서 제외합니다.
    //   - 정형 ESM 파일이라 Gemini 가 작은 잘못만 해도 SyntaxError 로 빌드 차단
    //   - 실제 hostname 추가는 결정론적 함수 updateNextConfigImages() 가 수행
    //   - 과거 사례: Gemini 응답에서 binary garbage / 이중 comma / remotePatterns 중첩 발생
    const candidateRelPaths = [
      ...uniqCss,
      'src/app/layout.tsx',
      ...tsxCandidates,
      ...cssCandidates,
    ].filter((rel, idx, arr) => arr.indexOf(rel) === idx && fs.existsSync(path.join(projectRoot, rel)));

    await stopAndOfferGeminiApply({
      projectRoot,
      discoveryLine: `CSS url() 안에 외부 HTTPS 이미지가 ${uniqCss.length}개 파일에서 감지되었습니다. next/image로 옮기면 LCP가 크게 개선됩니다.`,
      discoverySources: uniqCss.slice(0, 15),
      instructionForAi: `Next.js App Router 성능(step7) 작업입니다.

[목표]
- CSS background / background-image 의 url("https://...") 로 불러오는 큰 이미지(히어로/배너 등)는 Lighthouse LCP 후보가 되기 어렵습니다.
- 해당 URL을 next/image 로 옮기고, CSS에서는 배경 레이어(그라데이션 등)만 남기세요.

[권장 <Image> 속성 — LCP 최적화용]
- fill (또는 정확한 width/height)
- priority (LCP 후보일 때만)
- sizes="100vw" (풀스크린 hero 면 100vw, 섹션 폭이면 정확한 값)
- quality={70 ~ 80} (히어로처럼 흐릿해도 되는 큰 사진은 70~75 권장, 명시 안 하면 75)
- placeholder="empty" (LCP 면 blur 데이터를 만들 시간이 없으니 empty)
- 외부 호스트라면 layout 의 head 에 <link rel="preconnect" href="https://..." crossOrigin="anonymous" /> 가 들어 있는지 확인

[허용 변경]
- 관련 .tsx/.jsx 파일: <Image .../> 추가, 필요한 경우 wrapper div에 position:relative + min-height
- "발견 위치" 에 명시된 .css/.module.css 만 수정: 외부 url(...) 제거 또는 최소화(레이아웃 깨지지 않게)

[금지]
- 기능/라우팅/데이터 로직 변경, 무관한 파일 대규모 리팩터
- public 에 원본 이미지를 임의로 다운로드해 넣는 행위(외부 URL은 그대로 src로 사용)
- "발견 위치" 에 없는 .css/.module.css 파일 수정 (외부 url() 가 없는 CSS 는 그대로 두기)
- 응답에 화이트리스트로 받은 파일 외 다른 경로의 파일을 포함하지 말 것 (서버에서 거부됩니다)
- next.config.mjs / next.config.js / next.config.ts 변경 절대 금지 (도구가 자동으로 hostname 을 추가합니다. 이 파일을 응답에 포함하지 말 것)

[출력]
- 변경한 파일만 반환. 불확실하면 원본 유지.`,
      candidateRelPaths: candidateRelPaths.slice(0, 48),
    });
  }

  // next.config.mjs에 이미지 도메인 추가
  await updateNextConfigImages(projectRoot, Array.from(imageUrls));

  // C-1: 외부 이미지 호스트들에 대해 layout.tsx 에 <link rel="preconnect" /> 자동 주입.
  // - next/image 의 priority 는 <link rel="preload" as="image"> 만 자동 주입할 뿐
  //   외부 호스트의 TLS/DNS 핸드셰이크 비용은 막지 못합니다.
  // - 같은 호스트에 LCP 이미지가 있다면 preconnect 한 줄이 LCP 를 100~300ms 단축합니다.
  await injectPreconnectsToLayout(projectRoot, Array.from(imageUrls));
}

//=========================================================
// layout.tsx 의 <head> 에 외부 이미지 호스트용 preconnect 자동 주입
//=========================================================
async function injectPreconnectsToLayout(projectRoot, imageUrls) {
  const layoutPath = path.join(projectRoot, 'src', 'app', 'layout.tsx');
  if (!fs.existsSync(layoutPath)) return;

  const hostnames = new Set();
  for (const url of imageUrls) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      hostnames.add(u.hostname);
    } catch {
      // ignore
    }
  }
  if (hostnames.size === 0) return;

  let layoutContent = await fs.readFile(layoutPath, 'utf-8');
  const original = layoutContent;

  const headOpenMatch = layoutContent.match(/<head(\s[^>]*)?>/i);
  if (!headOpenMatch) return;

  const escapeForRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const newLinks = [];
  for (const host of hostnames) {
    const tag = `<link rel="preconnect" href="https://${host}" crossOrigin="anonymous" />`;
    const probe = new RegExp(
      '<link[^>]*rel=["\']preconnect["\'][^>]*href=["\']https?:\\/\\/' + escapeForRegex(host) + '["\']',
      'i',
    );
    if (probe.test(layoutContent)) continue;
    newLinks.push(tag);
  }

  if (newLinks.length === 0) return;

  const insertAt = headOpenMatch.index + headOpenMatch[0].length;
  layoutContent =
    layoutContent.slice(0, insertAt) +
    newLinks.join('') +
    layoutContent.slice(insertAt);

  if (layoutContent !== original) {
    await fs.writeFile(layoutPath, layoutContent, 'utf-8');
  }
}

//=========================================================
// next.config.mjs에 이미지 도메인 추가
//=========================================================
async function updateNextConfigImages(projectRoot, imageUrls) {
  const configPath = path.join(projectRoot, 'next.config.mjs');
  
  // next.config.mjs 파일이 없으면 종료
  if (!fs.existsSync(configPath)) {
    return;
  }

  // 이미지 URL에서 호스트네임 추출
  const hostnames = new Set();
  for (const url of imageUrls) {
    try {
      const urlObj = new URL(url);
      if (urlObj.hostname) {
        hostnames.add(urlObj.hostname);
      }
    } catch (e) {
      // URL 파싱 실패 시 무시
    }
  }

  if (hostnames.size === 0) {
    return;
  }

  let configContent = await fs.readFile(configPath, 'utf-8');
  
  // 기존 remotePatterns에서 호스트네임 추출 (중복 방지)
  const existingHostnames = new Set();
  const remotePatternsMatch = configContent.match(/remotePatterns:\s*\[([\s\S]*?)\]/);
  if (remotePatternsMatch) {
    const patternsContent = remotePatternsMatch[1];
        const hostnameMatches = patternsContent.matchAll(/hostname:\s*['"]([^'"]+)['"]/g);
    for (const match of hostnameMatches) {
      existingHostnames.add(match[1]);
    }
  }

  // 새로운 호스트네임만 추가
  const newHostnames = Array.from(hostnames).filter(h => !existingHostnames.has(h));
  
  if (newHostnames.length === 0) {
    return;
  }

  // remotePatterns가 이미 있는 경우
  if (remotePatternsMatch) {
    // 기존 remotePatterns 배열에 새 호스트네임 추가
    const patternsContent = remotePatternsMatch[1];
    const trimmedContent = patternsContent.trim();
    
    const newPatterns = newHostnames.map(hostname => {
      return `      {
        protocol: 'https',
        hostname: '${hostname}',
      },`;
    }).join('\n');
    
    // 기존 배열 끝에 새 패턴 추가 (마지막 항목의 쉼표 처리)
    const needsComma = trimmedContent.length > 0 && !trimmedContent.endsWith(',');
    const updatedPatterns = trimmedContent + 
      (needsComma ? ',' : '') + 
      '\n' + newPatterns;
    
    configContent = configContent.replace(
      remotePatternsMatch[0],
      `remotePatterns: [${updatedPatterns}\n    ]`
    );
  } else {
    // remotePatterns가 없는 경우 images 설정이 있는지 확인
    const imagesMatch = configContent.match(/images:\s*\{/);
    if (imagesMatch) {
      // images 설정이 있으면 remotePatterns 추가
      const imagesEndMatch = configContent.match(/images:\s*\{([\s\S]*?)\}/);
      if (imagesEndMatch) {
        const imagesContent = imagesEndMatch[1];
        const newPatterns = newHostnames.map(hostname => {
          return `    {
      protocol: 'https',
      hostname: '${hostname}',
    },`;
        }).join('\n');
        
        const updatedImages = imagesContent.trim() + 
          (imagesContent.trim() ? ',\n' : '') +
          '  remotePatterns: [\n' + newPatterns + '\n  ]';
        
        configContent = configContent.replace(
          imagesEndMatch[0],
          `images: {${updatedImages}\n  }`
        );
      }
    } else {
      // images 설정이 없으면 새로 추가
      const nextConfigMatch = configContent.match(/(const nextConfig = \{)/);
      if (nextConfigMatch) {
        const newPatterns = newHostnames.map(hostname => {
          return `    {
      protocol: 'https',
      hostname: '${hostname}',
    },`;
        }).join('\n');
        
        const imagesConfig = `  images: {
    remotePatterns: [
${newPatterns}
    ],
  },`;
        
        configContent = configContent.replace(
          nextConfigMatch[0],
          `${nextConfigMatch[1]}\n${imagesConfig}`
        );
      }
    }
  }

  await fs.writeFile(configPath, configContent, 'utf-8');
}

module.exports = {
  applyNextImage,
};

