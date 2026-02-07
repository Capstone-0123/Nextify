// src/step3/metadata-migrator.cjs
// 메타데이터 변환 모듈 (React Helmet → Next.js Metadata)

const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');

// ============================================================================
// 상수 정의
// ============================================================================

/**
 * 메타 태그 → Next.js Metadata 매핑 테이블
 */
const META_TAG_MAPPING = {
  // 3-1. 기본 태그 (Basic Fields)
  basic: {
    'description': { key: 'description', transform: 'string' },
    'keywords': { key: 'keywords', transform: 'array' },
    'author': { key: 'authors', transform: 'authorArray' },
    'application-name': { key: 'applicationName', transform: 'string' },
    'generator': { key: 'generator', transform: 'string' },
  },

  // 3-2. SNS 공유 태그 (Open Graph)
  openGraph: {
    'og:title': { key: 'title', transform: 'string' },
    'og:description': { key: 'description', transform: 'string' },
    'og:image': { key: 'images', transform: 'imageArray' },
    'og:url': { key: 'url', transform: 'string' },
    'og:type': { key: 'type', transform: 'string' },
    'og:site_name': { key: 'siteName', transform: 'string' },
    'og:locale': { key: 'locale', transform: 'string' },
  },

  // 3-2. Twitter 태그
  twitter: {
    'twitter:card': { key: 'card', transform: 'string' },
    'twitter:title': { key: 'title', transform: 'string' },
    'twitter:description': { key: 'description', transform: 'string' },
    'twitter:image': { key: 'images', transform: 'imageArray' },
    'twitter:site': { key: 'site', transform: 'string' },
    'twitter:creator': { key: 'creator', transform: 'string' },
  },

  // 3-3. 검색 로봇 (SEO)
  robots: {
    'robots': { key: 'robots', transform: 'robots' },
  },

  // 3-4. 뷰포트 및 테마 (별도 export)
  viewport: {
    'viewport': { key: 'viewport', transform: 'viewport' },
    'theme-color': { key: 'themeColor', transform: 'string' },
  },
};

/**
 * 링크 태그 → Next.js Metadata 매핑 테이블
 */
const LINK_TAG_MAPPING = {
  'canonical': { category: 'alternates', key: 'canonical', transform: 'string' },
  'icon': { category: 'icons', key: 'icon', transform: 'string' },
  'apple-touch-icon': { category: 'icons', key: 'apple', transform: 'string' },
  'shortcut icon': { category: 'icons', key: 'shortcut', transform: 'string' },
};

// ============================================================================
// 유틸리티 함수
// ============================================================================

/**
 * 값 변환 함수
 */
function transformValue(value, transformType) {
  if (!value) return null;

  switch (transformType) {
    case 'string':
      return value;

    case 'array':
      // "A, B, C" → ['A', 'B', 'C']
      return value.split(',').map(s => s.trim()).filter(s => s);

    case 'authorArray':
      // "이름" → [{ name: '이름' }]
      return [{ name: value }];

    case 'imageArray':
      // "url" → ['url']
      return [value];

    case 'robots':
      // "index, follow" → { index: true, follow: true }
      const parts = value.split(',').map(s => s.trim().toLowerCase());
      return {
        index: parts.includes('index'),
        follow: parts.includes('follow'),
        noindex: parts.includes('noindex'),
        nofollow: parts.includes('nofollow'),
      };

    case 'viewport':
      // "width=device-width, initial-scale=1" → { width: 'device-width', initialScale: 1 }
      const viewportObj = {};
      value.split(',').forEach(part => {
        const [key, val] = part.split('=').map(s => s.trim());
        const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        viewportObj[camelKey] = isNaN(val) ? val : Number(val);
      });
      return viewportObj;

    default:
      return value;
  }
}

/**
 * JSX 문자열에서 속성 값 추출
 */
function extractAttributeValue(jsxText, attrName) {
  // name="value" 또는 content="value" 또는 property="value" 패턴
  const patterns = [
    new RegExp(`${attrName}=["']([^"']+)["']`, 'i'),
    new RegExp(`${attrName}=\\{["']([^"']+)["']\\}`, 'i'),
    new RegExp(`${attrName}=\\{([^}]+)\\}`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = jsxText.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * 값이 정적(리터럴)인지 동적(변수)인지 판단
 */
function isStaticValue(value) {
  if (!value) return true;
  // 변수나 표현식이 포함되어 있으면 동적
  return !value.includes('{') && !value.includes('$');
}

// ============================================================================
// 정적 메타데이터 추출 (Case a)
// ============================================================================

/**
 * Helmet/Head 태그에서 정적 메타데이터 추출
 */
function extractStaticMetadata(jsxContent) {
  const metadata = {
    basic: {},
    openGraph: {},
    twitter: {},
    icons: {},
    alternates: {},
    robots: null,
  };
  const viewport = {};
  let title = null;
  let hasDynamicContent = false;

  // 1. <title> 태그 추출
  const titleMatch = jsxContent.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const titleValue = titleMatch[1];
    if (isStaticValue(titleValue)) {
      title = titleValue;
    } else {
      hasDynamicContent = true;
    }
  }

  // 2. <meta> 태그 추출
  const metaTagRegex = /<meta\s+([^>]+)\/?>/gi;
  let match;

  while ((match = metaTagRegex.exec(jsxContent)) !== null) {
    const tagContent = match[1];
    const name = extractAttributeValue(tagContent, 'name');
    const property = extractAttributeValue(tagContent, 'property');
    const content = extractAttributeValue(tagContent, 'content');

    if (!content) continue;

    // 동적 콘텐츠 체크
    if (!isStaticValue(content)) {
      hasDynamicContent = true;
      continue;
    }

    const identifier = name || property;
    if (!identifier) continue;

    // 기본 메타 태그
    if (META_TAG_MAPPING.basic[identifier]) {
      const mapping = META_TAG_MAPPING.basic[identifier];
      metadata.basic[mapping.key] = transformValue(content, mapping.transform);
    }

    // Open Graph 태그
    if (identifier.startsWith('og:') && META_TAG_MAPPING.openGraph[identifier]) {
      const mapping = META_TAG_MAPPING.openGraph[identifier];
      metadata.openGraph[mapping.key] = transformValue(content, mapping.transform);
    }

    // Twitter 태그
    if (identifier.startsWith('twitter:') && META_TAG_MAPPING.twitter[identifier]) {
      const mapping = META_TAG_MAPPING.twitter[identifier];
      metadata.twitter[mapping.key] = transformValue(content, mapping.transform);
    }

    // Robots 태그
    if (identifier === 'robots') {
      metadata.robots = transformValue(content, 'robots');
    }

    // Viewport 관련 (별도 export)
    if (identifier === 'viewport') {
      Object.assign(viewport, transformValue(content, 'viewport'));
    }
    if (identifier === 'theme-color') {
      viewport.themeColor = content;
    }
  }

  // 3. <link> 태그 추출
  const linkTagRegex = /<link\s+([^>]+)\/?>/gi;

  while ((match = linkTagRegex.exec(jsxContent)) !== null) {
    const tagContent = match[1];
    const rel = extractAttributeValue(tagContent, 'rel');
    const href = extractAttributeValue(tagContent, 'href');

    if (!rel || !href) continue;
    if (!isStaticValue(href)) {
      hasDynamicContent = true;
      continue;
    }

    if (LINK_TAG_MAPPING[rel]) {
      const mapping = LINK_TAG_MAPPING[rel];
      if (!metadata[mapping.category]) {
        metadata[mapping.category] = {};
      }
      metadata[mapping.category][mapping.key] = transformValue(href, mapping.transform);
    }
  }

  return {
    title,
    metadata,
    viewport,
    hasDynamicContent,
  };
}

// ============================================================================
// 동적 메타데이터 감지 (Case b)
// ============================================================================

/**
 * 동적 메타데이터 패턴 감지
 */
function detectDynamicMetadataPattern(sourceFile) {
  const patterns = {
    hasDataFetching: false,      // b-1: useEffect + fetch 패턴
    hasTitleTemplate: false,     // b-2: titleTemplate 패턴
    hasSearchParams: false,      // b-3: useLocation/useParams 패턴
    fetchFunction: null,
    titleTemplate: null,
    paramUsage: [],
  };

  const fullText = sourceFile.getFullText();

  // b-1: 데이터 패칭 패턴 감지
  // useEffect 내에서 fetch/axios 호출 후 title에 사용
  const useEffectCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(call => call.getExpression().getText() === 'useEffect');

  for (const call of useEffectCalls) {
    const callText = call.getText();
    if (callText.includes('fetch') || callText.includes('axios') || callText.includes('api')) {
      patterns.hasDataFetching = true;

      // 데이터 fetch 함수명 추출 시도
      const fetchMatch = callText.match(/(?:await\s+)?(\w+)\s*\(/);
      if (fetchMatch) {
        patterns.fetchFunction = fetchMatch[1];
      }
    }
  }

  // b-2: titleTemplate 패턴 감지
  const titleTemplateMatch = fullText.match(/titleTemplate\s*=\s*["']([^"']+)["']/);
  if (titleTemplateMatch) {
    patterns.hasTitleTemplate = true;
    patterns.titleTemplate = titleTemplateMatch[1];
  }

  // b-3: useLocation/useParams/useSearchParams 사용 감지
  const hasUseParams = fullText.includes('useParams');
  const hasUseLocation = fullText.includes('useLocation');
  const hasUseSearchParams = fullText.includes('useSearchParams');

  if (hasUseParams || hasUseLocation || hasUseSearchParams) {
    patterns.hasSearchParams = true;
    if (hasUseParams) patterns.paramUsage.push('params');
    if (hasUseLocation || hasUseSearchParams) patterns.paramUsage.push('searchParams');
  }

  return patterns;
}

/**
 * Helmet 태그 내 동적 title 패턴 추출
 */
function extractDynamicTitlePattern(jsxContent) {
  // <title>{data?.title}</title> 패턴
  const dynamicTitleMatch = jsxContent.match(/<title>\{([^}]+)\}<\/title>/);
  if (dynamicTitleMatch) {
    return {
      expression: dynamicTitleMatch[1],
      isDynamic: true,
    };
  }

  // <title>{data.title} - MySite</title> 패턴 (템플릿)
  const templateTitleMatch = jsxContent.match(/<title>\{([^}]+)\}\s*[-|]\s*([^<]+)<\/title>/);
  if (templateTitleMatch) {
    return {
      expression: templateTitleMatch[1],
      suffix: templateTitleMatch[2].trim(),
      isTemplate: true,
    };
  }

  return null;
}

// ============================================================================
// 메타데이터 코드 생성
// ============================================================================

/**
 * 정적 메타데이터 export 코드 생성
 */
function generateStaticMetadataCode(title, metadata, viewport) {
  const metadataObj = {};

  // title
  if (title) {
    metadataObj.title = title;
  }

  // 기본 필드
  Object.assign(metadataObj, metadata.basic);

  // Open Graph (객체가 비어있지 않으면 추가)
  if (Object.keys(metadata.openGraph).length > 0) {
    metadataObj.openGraph = metadata.openGraph;
  }

  // Twitter
  if (Object.keys(metadata.twitter).length > 0) {
    metadataObj.twitter = metadata.twitter;
  }

  // Icons
  if (Object.keys(metadata.icons).length > 0) {
    metadataObj.icons = metadata.icons;
  }

  // Alternates
  if (Object.keys(metadata.alternates).length > 0) {
    metadataObj.alternates = metadata.alternates;
  }

  // Robots
  if (metadata.robots) {
    metadataObj.robots = metadata.robots;
  }

  // 메타데이터 코드 생성
  let code = '';

  if (Object.keys(metadataObj).length > 0) {
    code += `import type { Metadata } from 'next';\n\n`;
    code += `export const metadata: Metadata = ${JSON.stringify(metadataObj, null, 2)};\n`;
  }

  // Viewport 코드 생성 (별도 export)
  if (Object.keys(viewport).length > 0) {
    code += `\nimport type { Viewport } from 'next';\n\n`;
    code += `export const viewport: Viewport = ${JSON.stringify(viewport, null, 2)};\n`;
  }

  return code;
}

/**
 * 동적 메타데이터 generateMetadata 함수 코드 생성
 */
function generateDynamicMetadataCode(patterns, componentInfo) {
  let code = `import type { Metadata } from 'next';\n`;

  // 데이터 패칭 함수 import (필요시)
  if (patterns.hasDataFetching && patterns.fetchFunction) {
    code += `// TODO: API 함수 import 경로 확인 필요\n`;
    code += `// import { ${patterns.fetchFunction} } from '@/api/...';\n\n`;
  }

  // generateMetadata 함수 생성
  code += `\nexport async function generateMetadata(`;

  const params = [];
  if (patterns.paramUsage.includes('params')) {
    params.push('{ params }');
  }
  if (patterns.paramUsage.includes('searchParams')) {
    params.push('{ searchParams }');
  }

  if (params.length > 0) {
    code += `\n  ${params.join(',\n  ')}\n`;
  }

  code += `): Promise<Metadata> {\n`;

  // params 추출 (Next.js 15+ 비동기 방식)
  if (patterns.paramUsage.includes('params')) {
    code += `  const { id } = await params;\n`;
  }
  if (patterns.paramUsage.includes('searchParams')) {
    code += `  const query = (await searchParams).q;\n`;
  }

  // 데이터 패칭
  if (patterns.hasDataFetching) {
    code += `\n  // [case 1: 데이터 패칭 로직]\n`;
    code += `  // const data = await ${patterns.fetchFunction || 'fetchData'}(id);\n`;
    code += `  // if (!data) return { title: 'Not Found' };\n`;
  }

  // 반환값
  code += `\n  return {\n`;
  code += `    title: '', // TODO: 동적 title 설정\n`;
  code += `    description: '', // TODO: 동적 description 설정\n`;
  code += `  };\n`;
  code += `}\n`;

  return code;
}

/**
 * titleTemplate 메타데이터 코드 생성 (layout.tsx용)
 */
function generateTitleTemplateCode(template, defaultTitle = 'My Site') {
  // "%s | MySite" 형식에서 패턴 추출
  const match = template.match(/%s\s*([-|])\s*(.+)/);

  let templateStr = template;
  let suffix = defaultTitle;

  if (match) {
    suffix = match[2];
    templateStr = `%s ${match[1]} ${suffix}`;
  }

  return `import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: {
    template: '${templateStr}',
    default: '${suffix}',
  },
};
`;
}

// ============================================================================
// 파일 처리 함수
// ============================================================================

/**
 * 컴포넌트 파일에서 Helmet/Head 태그 찾기
 */
function findHelmetContent(sourceFile) {
  const fullText = sourceFile.getFullText();

  // Helmet 태그 찾기
  const helmetMatch = fullText.match(/<Helmet[^>]*>([\s\S]*?)<\/Helmet>/i);
  if (helmetMatch) {
    return {
      type: 'Helmet',
      content: helmetMatch[1],
      fullMatch: helmetMatch[0],
    };
  }

  // Head 태그 찾기 (next/head 또는 react-helmet)
  const headMatch = fullText.match(/<Head[^>]*>([\s\S]*?)<\/Head>/i);
  if (headMatch) {
    return {
      type: 'Head',
      content: headMatch[1],
      fullMatch: headMatch[0],
    };
  }

  return null;
}

/**
 * page.tsx에 메타데이터 추가
 */
async function addMetadataToPage(pageFilePath, metadataCode) {
  let content = await fs.readFile(pageFilePath, 'utf-8');

  // 이미 metadata export가 있는지 확인
  if (content.includes('export const metadata') || content.includes('export async function generateMetadata')) {
    console.log(`   ⚠️ 이미 메타데이터가 존재합니다: ${path.basename(pageFilePath)}`);
    return false;
  }

  // import 문 다음, 첫 번째 export 또는 함수 선언 전에 삽입
  const importEndMatch = content.match(/^(import[\s\S]*?;\n)(?=\n*(?:export|const|function|async))/m);

  if (importEndMatch) {
    const insertPosition = importEndMatch.index + importEndMatch[0].length;
    content = content.slice(0, insertPosition) + '\n' + metadataCode + '\n' + content.slice(insertPosition);
  } else {
    // import가 없으면 파일 시작에 추가
    content = metadataCode + '\n' + content;
  }

  await fs.writeFile(pageFilePath, content);
  return true;
}

/**
 * 원본 컴포넌트의 Helmet 태그 주석 처리
 */
async function commentOutHelmet(componentFilePath, helmetContent) {
  let content = await fs.readFile(componentFilePath, 'utf-8');

  // Helmet 태그를 주석으로 변환
  const commented = content.replace(
    helmetContent.fullMatch,
    `{/* Migrated to Next.js Metadata API\n${helmetContent.fullMatch}\n*/}`
  );

  if (commented !== content) {
    await fs.writeFile(componentFilePath, commented);
    return true;
  }

  return false;
}

// ============================================================================
// 메인 함수
// ============================================================================

/**
 * 단일 페이지의 메타데이터 마이그레이션
 */
async function migratePageMetadata(projectRoot, pageFilePath, componentFilePath) {
  console.log(`   📄 처리 중: ${path.relative(projectRoot, pageFilePath)}`);

  // ts-morph 프로젝트 설정
  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
  });

  // 컴포넌트 파일 파싱
  if (!fs.existsSync(componentFilePath)) {
    console.log(`   ⚠️ 컴포넌트 파일을 찾을 수 없습니다: ${componentFilePath}`);
    return { success: false, reason: 'component_not_found' };
  }

  const componentFile = project.addSourceFileAtPath(componentFilePath);

  // Helmet/Head 태그 찾기
  const helmetContent = findHelmetContent(componentFile);

  if (!helmetContent) {
    console.log(`   ℹ️ Helmet/Head 태그가 없습니다.`);
    return { success: true, reason: 'no_helmet' };
  }

  // 동적 메타데이터 패턴 감지
  const dynamicPatterns = detectDynamicMetadataPattern(componentFile);

  // 정적 메타데이터 추출
  const { title, metadata, viewport, hasDynamicContent } = extractStaticMetadata(helmetContent.content);

  let metadataCode = '';
  let metadataType = 'static';

  // 메타데이터 유형 결정 및 코드 생성
  if (dynamicPatterns.hasDataFetching || dynamicPatterns.hasSearchParams || hasDynamicContent) {
    // 동적 메타데이터
    metadataType = 'dynamic';
    metadataCode = generateDynamicMetadataCode(dynamicPatterns, { title, metadata });

    // 정적 부분도 있으면 주석으로 추가
    if (title || Object.keys(metadata.basic).length > 0) {
      metadataCode += `\n// 정적 메타데이터 참고용:\n`;
      metadataCode += `// ${JSON.stringify({ title, ...metadata.basic })}\n`;
    }
  } else if (dynamicPatterns.hasTitleTemplate) {
    // 타이틀 템플릿 (layout.tsx용)
    metadataType = 'template';
    // layout.tsx에 추가하는 로직은 별도 처리 필요
    console.log(`   ℹ️ titleTemplate 감지됨 - layout.tsx에 수동 추가 필요`);
    metadataCode = generateTitleTemplateCode(dynamicPatterns.titleTemplate);
  } else {
    // 정적 메타데이터
    metadataCode = generateStaticMetadataCode(title, metadata, viewport);
  }

  if (!metadataCode) {
    console.log(`   ℹ️ 추출할 메타데이터가 없습니다.`);
    return { success: true, reason: 'no_metadata' };
  }

  // page.tsx에 메타데이터 추가
  const added = await addMetadataToPage(pageFilePath, metadataCode);

  if (added) {
    console.log(`   ✅ 메타데이터 추가 완료 (${metadataType})`);

    // 원본 Helmet 주석 처리
    await commentOutHelmet(componentFilePath, helmetContent);
    console.log(`   ✅ 원본 Helmet 주석 처리 완료`);
  }

  return {
    success: true,
    metadataType,
    title,
    metadata,
  };
}

/**
 * 프로젝트 전체 메타데이터 마이그레이션
 */
async function migrateMetadata(projectRoot) {
  console.log('🏷️  메타데이터 마이그레이션 시작...');

  const appDir = path.join(projectRoot, 'src/app');

  if (!fs.existsSync(appDir)) {
    console.warn('⚠️ src/app 디렉토리가 없습니다. Step 2를 먼저 실행하세요.');
    return;
  }

  // app 디렉토리 내 모든 page.tsx 파일 찾기
  const pageFiles = [];

  async function findPageFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await findPageFiles(fullPath);
      } else if (entry.name === 'page.tsx' || entry.name === 'page.jsx') {
        pageFiles.push(fullPath);
      }
    }
  }

  await findPageFiles(appDir);

  console.log(`   📁 발견된 페이지 파일: ${pageFiles.length}개`);

  const results = [];

  for (const pageFile of pageFiles) {
    // page.tsx에서 import된 컴포넌트 찾기
    const pageContent = await fs.readFile(pageFile, 'utf-8');

    // import 문에서 컴포넌트 경로 추출
    const importMatch = pageContent.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);

    if (importMatch) {
      const componentPath = importMatch[2];
      let absoluteComponentPath;

      // 상대 경로 해결
      if (componentPath.startsWith('.')) {
        absoluteComponentPath = path.resolve(path.dirname(pageFile), componentPath);
      } else if (componentPath.startsWith('@/')) {
        absoluteComponentPath = path.join(projectRoot, 'src', componentPath.slice(2));
      } else {
        // node_modules 패키지는 건너뜀
        continue;
      }

      // 확장자 추가
      const extensions = ['.tsx', '.jsx', '.ts', '.js'];
      for (const ext of extensions) {
        const tryPath = absoluteComponentPath + ext;
        if (fs.existsSync(tryPath)) {
          absoluteComponentPath = tryPath;
          break;
        }
        // 이미 확장자가 있는 경우
        if (fs.existsSync(absoluteComponentPath)) {
          break;
        }
      }

      if (fs.existsSync(absoluteComponentPath)) {
        const result = await migratePageMetadata(projectRoot, pageFile, absoluteComponentPath);
        results.push({ pageFile, componentPath: absoluteComponentPath, ...result });
      }
    }
  }

  // 결과 요약
  const successful = results.filter(r => r.success && r.metadataType);
  const staticCount = successful.filter(r => r.metadataType === 'static').length;
  const dynamicCount = successful.filter(r => r.metadataType === 'dynamic').length;

  console.log(`\n✅ 메타데이터 마이그레이션 완료:`);
  console.log(`   - 정적 메타데이터: ${staticCount}개`);
  console.log(`   - 동적 메타데이터: ${dynamicCount}개`);

  return results;
}

// ============================================================================
// 모듈 내보내기
// ============================================================================

module.exports = {
  migrateMetadata,
  migratePageMetadata,
  extractStaticMetadata,
  detectDynamicMetadataPattern,
  generateStaticMetadataCode,
  generateDynamicMetadataCode,
  generateTitleTemplateCode,
  META_TAG_MAPPING,
  LINK_TAG_MAPPING,
};
