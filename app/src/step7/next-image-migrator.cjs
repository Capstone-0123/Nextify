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

    // 4. 존재하지 않으면 파일 최상단에 import Image from "next/image"; 추가
    if (!hasNextImageImport) {
      // 첫 번째 import 문 앞에 추가
      const firstImportMatch = content.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        content = content.slice(0, insertIndex) + 
                  'import Image from "next/image";\n' + 
                  content.slice(insertIndex);
      } else {
        // import 문이 없으면 파일 최상단에 추가
        content = 'import Image from "next/image";\n' + content;
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

