// src/step4/tailwind-styled-migrator.cjs
// Tailwind CSS 및 Styled Components 자동 설정 모듈

const fs = require('fs-extra');
const path = require('path');

// ============================================================================
// Tailwind CSS 버전 감지
// ============================================================================

/**
 * Tailwind CSS 버전 감지 (명세 4)
 * @param {string} projectRoot - 프로젝트 루트 경로
 * @returns {string|null} 'v3' | 'v4' | null
 */
function detectTailwindVersion(projectRoot) {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson = fs.readJsonSync(packageJsonPath);
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    // tailwindcss 의존성 확인
    if (!dependencies.tailwindcss) {
      return null;
    }

    const version = dependencies.tailwindcss;

    // 버전 파싱
    // ^3.4.1, ~3.4.1, 3.4.1 등의 형식 처리
    const cleanVersion = version.replace(/[\^~>=<]/g, '');
    const majorVersion = parseInt(cleanVersion.split('.')[0], 10);

    if (majorVersion === 3) {
      return 'v3';
    } else if (majorVersion === 4) {
      return 'v4';
    } else {
      // 버전이 애매한 경우 (^, ~ 등): tailwind.config.js 존재 여부로 판단
      const configPath = path.join(projectRoot, 'tailwind.config.js');
      const configExists = fs.existsSync(configPath);
      return configExists ? 'v3' : 'v4';
    }
  } catch (error) {
    return null;
  }
}

// ============================================================================
// Tailwind CSS v3 설정 업데이트
// ============================================================================

/**
 * Tailwind v3 설정 업데이트 (명세 2)
 * @param {string} projectRoot - 프로젝트 루트 경로
 * @returns {boolean} 성공 여부
 */
function updateTailwindConfigV3(projectRoot) {
  const configPath = path.join(projectRoot, 'tailwind.config.js');
  
  if (!fs.existsSync(configPath)) {
    return false;
  }

  try {
    let configContent = fs.readFileSync(configPath, 'utf8');
    const originalContent = configContent;

    // content 배열 패턴 찾기
    // content: [...] 또는 content: [...] 형식 매칭 (중첩 배열도 고려)
    const contentPattern = /content\s*:\s*\[([\s\S]*?)\]/;
    const match = configContent.match(contentPattern);

    if (!match) {
      return false;
    }

    const contentArrayStr = match[1];
    
    // 이미 포함된 포괄적인 패턴 확인
    const comprehensivePatterns = [
      './src/**/*.{js,ts,jsx,tsx}',
      './app/**/*.{ts,tsx}',
      './src/**/**',
      './src/**/*.{ts,tsx}', // 추가할 패턴
    ];

    // content 배열에 이미 포괄적인 패턴이 있는지 확인
    const hasComprehensivePattern = comprehensivePatterns.some(pattern => {
      // 따옴표 처리 (', ", `) 및 이스케이프 처리
      const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 다양한 따옴표 형식과 공백 허용
      const regex = new RegExp(`['"\`]\\s*${escapedPattern}\\s*['"\`]`);
      return regex.test(contentArrayStr);
    });

    if (hasComprehensivePattern) {
      return false;
    }

    // content 배열에 "./src/**/*.{ts,tsx}" 추가
    // 배열의 마지막 항목 뒤에 추가
    const trimmedContent = contentArrayStr.trim();
    let newContentArrayStr;
    
    if (trimmedContent.length > 0) {
      // 마지막 항목이 있으면 쉼표 추가 후 새 항목 추가
      // 들여쓰기 유지
      const indentMatch = configContent.match(/content\s*:\s*\[\s*\n(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '        ';
      
      // 마지막에 쉼표가 없으면 추가
      const needsComma = !trimmedContent.endsWith(',');
      newContentArrayStr = trimmedContent + (needsComma ? ',' : '') + `\n${indent}"./src/**/*.{ts,tsx}"`;
    } else {
      // 빈 배열이면 바로 추가
      newContentArrayStr = `"./src/**/*.{ts,tsx}"`;
    }

    // content 배열 교체
    const newContentArray = `[${newContentArrayStr}]`;
    configContent = configContent.replace(contentPattern, `content: ${newContentArray}`);

    if (configContent !== originalContent) {
      fs.writeFileSync(configPath, configContent, 'utf8');
      return true;
    }

    return false;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// Tailwind CSS v4 설정 업데이트
// ============================================================================

/**
 * Tailwind v4 설정 업데이트 (명세 3)
 * @param {string} projectRoot - 프로젝트 루트 경로
 * @returns {boolean} 성공 여부
 */
function updateTailwindCSSV4(projectRoot) {
  // 대상 파일 검색 순서: src/app/globals.css → app/globals.css → src/index.css
  const possiblePaths = [
    path.join(projectRoot, 'src', 'app', 'globals.css'),
    path.join(projectRoot, 'app', 'globals.css'),
    path.join(projectRoot, 'src', 'index.css'),
  ];

  let targetPath = null;
  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      targetPath = filePath;
      break;
    }
  }

  // 파일이 없으면 src/app/globals.css 생성
  if (!targetPath) {
    targetPath = path.join(projectRoot, 'src', 'app', 'globals.css');
    const dirPath = path.dirname(targetPath);
    fs.ensureDirSync(dirPath);
    fs.writeFileSync(targetPath, '', 'utf8');
  }

  try {
    let cssContent = fs.readFileSync(targetPath, 'utf8');
    const originalContent = cssContent;
    let modified = false;

    // @import "tailwindcss"; 확인 및 추가
    if (!cssContent.includes('@import "tailwindcss";')) {
      // 파일 맨 위에 추가 (기존 내용이 있으면 그 위에)
      cssContent = '@import "tailwindcss";\n' + cssContent;
      modified = true;
    }

    // @source "../src"; 확인 및 추가 (필요시)
    // Next.js 구조 인식을 위해 필요할 수 있음
    const needsSource = !cssContent.includes('@source');
    if (needsSource) {
      // @import 다음에 추가
      cssContent = cssContent.replace(
        /(@import\s+"tailwindcss";)/,
        '$1\n@source "../src";'
      );
      modified = true;
    }

    if (modified && cssContent !== originalContent) {
      fs.writeFileSync(targetPath, cssContent, 'utf8');
      return true;
    }

    return false;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// Styled Components SSR 설정
// ============================================================================

/**
 * Styled Components SSR 설정 (명세 0-1)
 * @param {string} projectRoot - 프로젝트 루트 경로
 * @returns {boolean} 성공 여부
 */
function updateNextConfigForStyled(projectRoot) {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  
  // 1. package.json에서 styled-components 의존성 확인
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = fs.readJsonSync(packageJsonPath);
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    if (!dependencies['styled-components']) {
      return false;
    }

    // 2. next.config.js 또는 next.config.mjs 파일 확인
    const configPaths = [
      path.join(projectRoot, 'next.config.js'),
      path.join(projectRoot, 'next.config.mjs'),
    ];

    let configPath = null;
    let isMjs = false;
    
    for (const filePath of configPaths) {
      if (fs.existsSync(filePath)) {
        configPath = filePath;
        isMjs = filePath.endsWith('.mjs');
        break;
      }
    }

    // 3. 파일이 없으면 새로 생성
    if (!configPath) {
      configPath = path.join(projectRoot, 'next.config.js');
      const defaultConfig = `module.exports = {
  reactStrictMode: true,
  compiler: {
    styledComponents: true
  }
}
`;
      fs.writeFileSync(configPath, defaultConfig, 'utf8');
      return true;
    }

    // 4. 파일이 있으면 설정 병합
    let configContent = fs.readFileSync(configPath, 'utf8');
    const originalContent = configContent;

    // compiler.styledComponents가 이미 있는지 확인
    const hasStyledComponents = /styledComponents\s*:\s*true/.test(configContent);
    
    if (hasStyledComponents) {
      return false;
    }

    // compiler 속성이 있는지 확인
    const hasCompiler = /compiler\s*:\s*\{/.test(configContent);

    if (hasCompiler) {
      // compiler가 있으면 styledComponents만 추가
      // compiler: { ... } 내부에 styledComponents: true 추가
      // 중첩된 객체도 고려하여 더 정확한 매칭
      configContent = configContent.replace(
        /(compiler\s*:\s*\{)([\s\S]*?)(\n\s*\})/,
        (match, open, compilerContent, closingBrace) => {
          // 이미 styledComponents가 있는지 다시 확인 (더 정확하게)
          if (/styledComponents\s*:/.test(compilerContent)) {
            return match;
          }
          // 들여쓰기 확인
          const indentMatch = closingBrace.match(/(\n\s*)\}/);
          const indent = indentMatch ? indentMatch[1].replace(/\n/, '') : '  ';
          
          // 마지막 속성 뒤에 쉼표 추가 후 styledComponents 추가
          const trimmed = compilerContent.trimEnd();
          const needsComma = !trimmed.endsWith(',') && !trimmed.endsWith('{') && trimmed.length > 0;
          return `${open}${trimmed}${needsComma ? ',' : ''}\n${indent}styledComponents: true${closingBrace}`;
        }
      );
    } else {
      // compiler가 없으면 통째로 추가
      // module.exports = { ... } 또는 export default { ... } 패턴 찾기
      // 마지막 중괄호를 정확히 찾기 위해 더 정교한 패턴 사용
      if (isMjs) {
        // ES modules - export default { ... } 패턴
        // 중첩 객체를 고려하여 마지막 }를 찾음
        let braceCount = 0;
        let lastBraceIndex = -1;
        for (let i = 0; i < configContent.length; i++) {
          if (configContent[i] === '{') braceCount++;
          if (configContent[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              lastBraceIndex = i;
              break;
            }
          }
        }
        
        if (lastBraceIndex > 0) {
          const beforeBrace = configContent.substring(0, lastBraceIndex);
          const afterBrace = configContent.substring(lastBraceIndex);
          
          // 마지막 속성 확인
          const trimmed = beforeBrace.trimEnd();
          const needsComma = !trimmed.endsWith(',') && !trimmed.endsWith('{') && trimmed.length > 0;
          configContent = `${trimmed}${needsComma ? ',' : ''}\n  compiler: {\n    styledComponents: true\n  }${afterBrace}`;
        }
      } else {
        // CommonJS - module.exports = { ... } 패턴
        // 중첩 객체를 고려하여 마지막 }를 찾음
        let braceCount = 0;
        let lastBraceIndex = -1;
        for (let i = 0; i < configContent.length; i++) {
          if (configContent[i] === '{') braceCount++;
          if (configContent[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              lastBraceIndex = i;
              break;
            }
          }
        }
        
        if (lastBraceIndex > 0) {
          const beforeBrace = configContent.substring(0, lastBraceIndex);
          const afterBrace = configContent.substring(lastBraceIndex);
          
          // 마지막 속성 확인
          const trimmed = beforeBrace.trimEnd();
          const needsComma = !trimmed.endsWith(',') && !trimmed.endsWith('{') && trimmed.length > 0;
          configContent = `${trimmed}${needsComma ? ',' : ''}\n  compiler: {\n    styledComponents: true\n  }${afterBrace}`;
        }
      }
    }

    if (configContent !== originalContent) {
      fs.writeFileSync(configPath, configContent, 'utf8');
      return true;
    }

    return false;
  } catch (error) {
    return false;
  }
}

// ============================================================================
// 메인 실행 함수
// ============================================================================

/**
 * Tailwind CSS 및 Styled Components 자동 설정 실행
 * @param {string} projectRoot - 프로젝트 루트 경로
 */
async function migrateTailwindAndStyled(projectRoot) {
  // 1. Tailwind CSS 처리
  const tailwindVersion = detectTailwindVersion(projectRoot);
  
  if (tailwindVersion === 'v3') {
    updateTailwindConfigV3(projectRoot);
  } else if (tailwindVersion === 'v4') {
    updateTailwindCSSV4(projectRoot);
  }

  // 2. Styled Components 처리
  updateNextConfigForStyled(projectRoot);
}

module.exports = {
  detectTailwindVersion,
  updateTailwindConfigV3,
  updateTailwindCSSV4,
  updateNextConfigForStyled,
  migrateTailwindAndStyled,
};
