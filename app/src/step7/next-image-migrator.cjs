// src/step7/next-image-migrator.cjs
// next/image 적용

const fs = require('fs-extra');
const path = require('path');

//=========================================================
// next/image 적용 메인 함수
//=========================================================
async function applyNextImage(projectRoot) {
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

  // ─── 상태머신 기반 <img> 태그 파인더 ────────────────────────────────────
  // 기존 정규식은 onClick={() => ...} 의 '=>' 에서 '>'를 잘못 인식하거나
  // 템플릿 리터럴 `...` 안의 `}` 로 중괄호 균형이 깨지는 버그가 있었다.
  function findImgTagsInContent(content) {
    const tags = [];
    let i = 0;

    while (i < content.length) {
      const start = content.indexOf('<img', i);
      if (start === -1) break;

      // <img 뒤에 바로 \w 가 오면 다른 태그 이름(예: <imglist) — 건너뜀
      const afterKeyword = start + 4;
      if (afterKeyword < content.length && /\w/.test(content[afterKeyword])) {
        i = afterKeyword;
        continue;
      }

      // 상태머신으로 태그 끝 위치 탐색
      let j = afterKeyword;
      let depth = 0;      // {} 깊이
      let inStr = null;   // null | '"' | "'" | '`'
      let tmplDepth = 0;  // 템플릿 리터럴 내부 ${...} 깊이
      let found = false;

      while (j < content.length) {
        const ch = content[j];

        if (inStr !== null) {
          if (inStr === '`') {
            if (ch === '\\') { j += 2; continue; }
            if (ch === '`') { inStr = null; j++; continue; }
            if (ch === '$' && content[j + 1] === '{') { tmplDepth++; j += 2; continue; }
          } else {
            if (ch === '\\') { j += 2; continue; }
            if (ch === inStr) { inStr = null; j++; continue; }
          }
          j++;
          continue;
        }

        if (tmplDepth > 0) {
          if (ch === '{') { tmplDepth++; }
          else if (ch === '}') { tmplDepth--; }
          else if (ch === '"' || ch === "'") { inStr = ch; }
          else if (ch === '`') { inStr = '`'; }
          j++;
          continue;
        }

        // 평문(문자열/표현식 밖)
        if (ch === '"' || ch === "'") { inStr = ch; j++; continue; }
        if (ch === '`') { inStr = '`'; j++; continue; }
        if (ch === '{') { depth++; j++; continue; }
        if (ch === '}') { depth--; j++; continue; }

        if (depth === 0) {
          if (ch === '/' && content[j + 1] === '>') {
            const end = j + 2;
            tags.push({
              fullMatch: content.slice(start, end),
              attributes: content.slice(afterKeyword, j).trim(),
              index: start,
            });
            i = end;
            found = true;
            break;
          }
          if (ch === '>') {
            const end = j + 1;
            tags.push({
              fullMatch: content.slice(start, end),
              attributes: content.slice(afterKeyword, j).trim(),
              index: start,
            });
            i = end;
            found = true;
            break;
          }
        }
        j++;
      }

      if (!found) break; // 닫히지 않은 태그면 탐색 중단
    }

    return tags;
  }

  // ─── 중괄호/따옴표 인식 JSX 속성 파서 ──────────────────────────────────
  // 기존 코드의 `[^}]*` 정규식은 onClick={() => ...} 이나 alt={`tmpl ${x}`} 처럼
  // 중첩 괄호/템플릿 리터럴이 있는 경우 값을 잘라냈다.
  function parseJsxAttributeList(attrString) {
    const attrList = [];
    let rem = attrString.trim();

    while (rem.length > 0) {
      rem = rem.trimStart();
      if (!rem.length) break;

      // 속성 키
      const keyM = /^([\w-]+)/.exec(rem);
      if (!keyM) { rem = rem.slice(1); continue; }
      const key = keyM[1];
      rem = rem.slice(key.length).trimStart();

      if (!rem.length || rem[0] !== '=') {
        attrList.push({ key, value: true, isBoolean: true });
        continue;
      }
      rem = rem.slice(1).trimStart(); // '=' 소비

      if (!rem.length) { attrList.push({ key, value: true, isBoolean: true }); break; }

      const fc = rem[0];

      if (fc === '"' || fc === "'") {
        // 따옴표 문자열 값
        let end = 1;
        while (end < rem.length) {
          if (rem[end] === '\\') { end += 2; continue; }
          if (rem[end] === fc) { end++; break; }
          end++;
        }
        attrList.push({ key, value: rem.slice(1, end - 1), isString: true, quote: fc });
        rem = rem.slice(end);
        continue;
      }

      if (fc === '{') {
        // 중괄호 균형을 직접 추적
        let depth = 1;
        let j = 1;
        let inS = null;
        let tmplD = 0;

        while (j < rem.length && depth > 0) {
          const ch = rem[j];
          if (inS !== null) {
            if (inS === '`') {
              if (ch === '\\') { j += 2; continue; }
              if (ch === '`') { inS = null; }
              else if (ch === '$' && rem[j + 1] === '{') { tmplD++; j += 2; continue; }
            } else {
              if (ch === '\\') { j += 2; continue; }
              if (ch === inS) { inS = null; }
            }
          } else if (tmplD > 0) {
            if (ch === '{') tmplD++;
            else if (ch === '}') tmplD--;
            else if (ch === '"' || ch === "'") inS = ch;
            else if (ch === '`') inS = '`';
          } else {
            if (ch === '"' || ch === "'") { inS = ch; }
            else if (ch === '`') { inS = '`'; }
            else if (ch === '{') depth++;
            else if (ch === '}') depth--;
          }
          j++;
        }

        attrList.push({ key, value: rem.slice(1, j - 1), isJSX: true });
        rem = rem.slice(j);
        continue;
      }

      // 그 외 — 다음 공백까지를 값으로
      const spaceIdx = rem.search(/\s/);
      const val = spaceIdx === -1 ? rem : rem.slice(0, spaceIdx);
      attrList.push({ key, value: val, isJSX: true });
      rem = spaceIdx === -1 ? '' : rem.slice(spaceIdx);
    }

    return attrList;
  }

  // 파일 내 <img> 태그를 <Image> 태그로 변환
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;
    
    // 이미지 URL 수집 (next.config.mjs 업데이트용)
    const fileImageUrls = [];

    // 상태머신 기반 <img> 태그 탐색 (=> 나 템플릿 리터럴에 취약했던 regex 대체)
    const imgTags = findImgTagsInContent(content);

    // src 속성에서 URL 수집
    for (const tag of imgTags) {
      const srcM = /src\s*=\s*(["'])([^"']*)\1/.exec(tag.attributes)
        || /src\s*=\{([^}]*)\}/.exec(tag.attributes);
      if (srcM) {
        const url = (srcM[2] || srcM[1] || '').trim();
        if (url.startsWith('http://') || url.startsWith('https://')) {
          fileImageUrls.push(url);
        }
      }
    }

    // 파일 전체에서 이미지 URL 추출 (함수 호출 등 포함)
    const urlPattern = /(?:https?:\/\/[^\s"'`\)]+)/g;
    let urlMatch;
    while ((urlMatch = urlPattern.exec(content)) !== null) {
      const url = urlMatch[0];
      if (url.includes('image') || url.includes('img') || url.match(/\.(jpg|jpeg|png|gif|webp|svg)/i)) {
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

    // 4. 존재하지 않으면 import 삽입 — "use client"/"use server" 를 파일 첫 줄로 보존
    const importLine = 'import Image from "next/image";\n';
    if (!hasNextImageImport) {
      // "use client" / "use server" 디렉티브가 파일 맨 앞에 있으면 그 뒤에 삽입
      const directiveRe = /^(['"]use (?:client|server)['"]\s*;?\s*\r?\n)/;
      const directiveMatch = directiveRe.exec(content);
      let insertIndex;
      if (directiveMatch) {
        insertIndex = directiveMatch[0].length;
      } else {
        const firstImportMatch = content.match(/^import\s+/m);
        insertIndex = firstImportMatch ? firstImportMatch.index : 0;
      }
      content = content.slice(0, insertIndex) + importLine + content.slice(insertIndex);
      const delta = importLine.length;
      for (const tag of imgTags) {
        if (tag.index >= insertIndex) tag.index += delta;
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

  // <img> 태그를 <Image> 태그로 변환
  function convertImgToImage(attributes) {
    // 중괄호/따옴표 인식 파서로 속성 파싱
    const attrList = parseJsxAttributeList(attributes);
    const attrMap = {};
    for (const a of attrList) attrMap[a.key] = a.value;

    // 6. src, alt 속성은 그대로 유지
    // 8. className, style, priority 등 기존 속성은 유지
    const preservedAttrs = ['src', 'alt', 'className', 'style', 'priority', 'width', 'height', 'onClick', 'onLoad', 'onError'];
    const newAttrs = [];

    // 7. width, height 속성이 없는 경우 처리
    const hasWidth = 'width' in attrMap;
    const hasHeight = 'height' in attrMap;
    const srcValue = attrMap.src;

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
      urls.forEach(url => imageUrls.add(url));
    }
  }

  // next.config.mjs에 이미지 도메인 추가
  await updateNextConfigImages(projectRoot, Array.from(imageUrls));
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

