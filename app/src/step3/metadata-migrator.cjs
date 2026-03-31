// src/step3/metadata-migrator.cjs
// 메타데이터 변환 모듈 (React Helmet → Next.js Metadata)

const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');
const {
  stopAndOfferGeminiApply,
  collectMigrationCandidateRelPaths,
} = require('../utils/manual-flow.cjs');

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

/**
 * Helmet 태그에서 모든 동적 메타데이터 표현식 추출
 */
function extractDynamicMetadataExpressions(jsxContent) {
  const expressions = {
    title: null,
    titleSuffix: null,
    description: null,
    openGraph: {},
    twitter: {},
    images: [],
  };

  // 1. <title> 태그 (동적)
  // 패턴: <title>{expr}</title> 또는 <title>{expr} - Suffix</title>
  const titleMatch = jsxContent.match(/<title>\{([^}]+)\}(?:\s*[-|]\s*([^<]+))?<\/title>/);
  if (titleMatch) {
    expressions.title = titleMatch[1].trim();
    if (titleMatch[2]) {
      expressions.titleSuffix = titleMatch[2].trim();
    }
  }

  // 2. <meta name="description"> (동적)
  const descMatch = jsxContent.match(/<meta\s+name=["']description["']\s+content=\{([^}]+)\}/);
  if (descMatch) {
    expressions.description = descMatch[1].trim();
  }

  // 3. Open Graph 메타 태그들
  const ogPatterns = [
    { regex: /<meta\s+property=["']og:title["']\s+content=\{([^}]+)\}/, key: 'title' },
    { regex: /<meta\s+property=["']og:description["']\s+content=\{([^}]+)\}/, key: 'description' },
    { regex: /<meta\s+property=["']og:image["']\s+content=\{([^}]+)\}/, key: 'images' },
    { regex: /<meta\s+property=["']og:url["']\s+content=\{([^}]+)\}/, key: 'url' },
    { regex: /<meta\s+property=["']og:type["']\s+content=\{([^}]+)\}/, key: 'type' },
  ];

  for (const { regex, key } of ogPatterns) {
    const match = jsxContent.match(regex);
    if (match) {
      if (key === 'images') {
        expressions.openGraph[key] = `[${match[1].trim()}]`;
      } else {
        expressions.openGraph[key] = match[1].trim();
      }
    }
  }

  // 4. Twitter 메타 태그들
  const twitterPatterns = [
    { regex: /<meta\s+name=["']twitter:title["']\s+content=\{([^}]+)\}/, key: 'title' },
    { regex: /<meta\s+name=["']twitter:description["']\s+content=\{([^}]+)\}/, key: 'description' },
    { regex: /<meta\s+name=["']twitter:image["']\s+content=\{([^}]+)\}/, key: 'images' },
    { regex: /<meta\s+name=["']twitter:card["']\s+content=\{([^}]+)\}/, key: 'card' },
  ];

  for (const { regex, key } of twitterPatterns) {
    const match = jsxContent.match(regex);
    if (match) {
      if (key === 'images') {
        expressions.twitter[key] = `[${match[1].trim()}]`;
      } else {
        expressions.twitter[key] = match[1].trim();
      }
    }
  }

  return expressions;
}

/**
 * 동적 표현식에서 데이터 변수명 추출 (예: movie.title → movie)
 */
function extractDataVariableName(expressions) {
  const allExpressions = [
    expressions.title,
    expressions.description,
    ...Object.values(expressions.openGraph),
    ...Object.values(expressions.twitter),
  ].filter(Boolean);

  for (const expr of allExpressions) {
    // movie.title, data.name, post?.content 등에서 루트 변수명 추출
    const match = expr.match(/^(\w+)[\.\?]/);
    if (match) {
      return match[1];
    }
  }

  return 'data';
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
 * 동적 메타데이터용 최소 뼈대.
 * 직후 stopAndOfferGeminiApply(step1과 동일 흐름)로 채움.
 */
function generateDynamicMetadataStub(patterns) {
  let code = `import type { Metadata } from 'next';\n\n`;

  code += `export async function generateMetadata(`;

  const sigParts = [];
  if (patterns.paramUsage.includes('params')) {
    sigParts.push('{ params }');
  }
  if (patterns.paramUsage.includes('searchParams')) {
    sigParts.push('{ searchParams }');
  }

  if (sigParts.length > 0) {
    code += `\n  ${sigParts.join(',\n  ')}\n`;
  }

  code += `): Promise<Metadata> {\n`;

  if (patterns.paramUsage.includes('params')) {
    code += `  void (await params);\n`;
  }
  if (patterns.paramUsage.includes('searchParams')) {
    code += `  void (await searchParams);\n`;
  }

  code += `  return {\n    title: '',\n    description: '',\n  };\n`;
  code += `}\n`;

  return code;
}

// NOTE:
// 동적 메타데이터는 이제 전부 Gemini 경로로 처리한다.
// 아래 레거시 함수는 참고용으로만 보존한다(실행 경로에서 미사용).
/*
function generateDynamicMetadataCode(patterns, componentInfo, dynamicExpressions = null) {
  let code = `import type { Metadata } from 'next';\n`;
  ...
  return code;
}
*/

// NOTE:
// titleTemplate 동적 변환 또한 Gemini 경로로 통합했다.
// 아래 레거시 함수는 참고용으로만 보존한다(실행 경로에서 미사용).
/*
function generateTitleTemplateCode(template, defaultTitle = 'My Site') {
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
*/

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
// 루트 Layout.tsx의 <head> 태그 처리
// ============================================================================

/**
 * layout.tsx의 <head> 태그에서 메타데이터 추출
 */
function extractMetadataFromHead(headContent) {
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
  const otherTags = []; // preconnect 등 Next.js에서 직접 지원하지 않는 태그

  // 1. <title> 태그 추출
  const titleMatch = headContent.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // 2. <meta> 태그 추출
  const metaTagRegex = /<meta\s+([^>]+)\/?>/gi;
  let match;

  while ((match = metaTagRegex.exec(headContent)) !== null) {
    const tagContent = match[0];
    const fullTag = match[0];

    // charSet은 Next.js에서 자동 처리
    if (tagContent.includes('charSet') || tagContent.includes('charset')) {
      continue;
    }

    const name = extractAttributeValue(tagContent, 'name');
    const property = extractAttributeValue(tagContent, 'property');
    const content = extractAttributeValue(tagContent, 'content');

    // viewport 처리
    if (name === 'viewport' && content) {
      Object.assign(viewport, transformValue(content, 'viewport'));
      continue;
    }

    // theme-color 처리
    if (name === 'theme-color' && content) {
      viewport.themeColor = content;
      continue;
    }

    if (!content) continue;

    const identifier = name || property;
    if (!identifier) continue;

    // 기본 메타 태그
    if (META_TAG_MAPPING.basic[identifier]) {
      const mapping = META_TAG_MAPPING.basic[identifier];
      metadata.basic[mapping.key] = transformValue(content, mapping.transform);
    }
    // Open Graph 태그
    else if (identifier.startsWith('og:') && META_TAG_MAPPING.openGraph[identifier]) {
      const mapping = META_TAG_MAPPING.openGraph[identifier];
      metadata.openGraph[mapping.key] = transformValue(content, mapping.transform);
    }
    // Twitter 태그
    else if (identifier.startsWith('twitter:') && META_TAG_MAPPING.twitter[identifier]) {
      const mapping = META_TAG_MAPPING.twitter[identifier];
      metadata.twitter[mapping.key] = transformValue(content, mapping.transform);
    }
    // Robots 태그
    else if (identifier === 'robots') {
      metadata.robots = transformValue(content, 'robots');
    }
  }

  // 3. <link> 태그 추출
  const linkTagRegex = /<link\s+([^>]+)\/?>/gi;

  while ((match = linkTagRegex.exec(headContent)) !== null) {
    const tagContent = match[0];
    const rel = extractAttributeValue(tagContent, 'rel');
    const href = extractAttributeValue(tagContent, 'href');
    const type = extractAttributeValue(tagContent, 'type');

    if (!rel) continue;

    // icon 관련
    if (rel === 'icon' || rel === 'shortcut icon') {
      metadata.icons.icon = href;
      continue;
    }
    if (rel === 'apple-touch-icon') {
      metadata.icons.apple = href;
      continue;
    }

    // canonical
    if (rel === 'canonical' && href) {
      metadata.alternates.canonical = href;
      continue;
    }

    // preconnect, preload 등은 Next.js Metadata API에서 직접 지원하지 않음
    // 이런 태그들은 별도로 보존
    if (rel === 'preconnect' || rel === 'preload' || rel === 'dns-prefetch') {
      otherTags.push(tagContent);
    }
  }

  return {
    title,
    metadata,
    viewport,
    otherTags,
  };
}

/**
 * 루트 layout.tsx 파일의 메타데이터 마이그레이션
 */
async function migrateRootLayoutMetadata(projectRoot) {
  const rootLayoutPath = path.join(projectRoot, 'src/app/layout.tsx');

  if (!fs.existsSync(rootLayoutPath)) {
    return { success: false, reason: 'no_root_layout' };
  }

  let content = await fs.readFile(rootLayoutPath, 'utf-8');

  // 이미 metadata export가 있는지 확인
  if (content.includes('export const metadata') || content.includes('export async function generateMetadata')) {
    return { success: false, reason: 'already_has_metadata' };
  }

  // <head> 태그 내용 추출
  const headMatch = content.match(/<head[^>]*>([\s\S]*?)<\/head>/i);

  if (!headMatch) {
    return { success: false, reason: 'no_head_tag' };
  }

  const headContent = headMatch[1];

  // 메타데이터 추출
  const { title, metadata, viewport, otherTags } = extractMetadataFromHead(headContent);

  // 추출된 메타데이터가 있는지 확인
  const hasTitle = !!title;
  const hasBasicMeta = Object.keys(metadata.basic).length > 0;
  const hasIcons = Object.keys(metadata.icons).length > 0;
  const hasViewport = Object.keys(viewport).length > 0;
  const hasOpenGraph = Object.keys(metadata.openGraph).length > 0;
  const hasTwitter = Object.keys(metadata.twitter).length > 0;

  if (!hasTitle && !hasBasicMeta && !hasIcons && !hasViewport && !hasOpenGraph && !hasTwitter) {
    return { success: false, reason: 'no_metadata' };
  }

  // 메타데이터 코드 생성
  let metadataCode = '';

  // Metadata import 추가
  const needsMetadataImport = hasTitle || hasBasicMeta || hasIcons || hasOpenGraph || hasTwitter;
  const needsViewportImport = hasViewport;

  if (needsMetadataImport || needsViewportImport) {
    const imports = [];
    if (needsMetadataImport) imports.push('Metadata');
    if (needsViewportImport) imports.push('Viewport');
    metadataCode += `import type { ${imports.join(', ')} } from 'next';\n\n`;
  }

  // metadata export 생성
  if (needsMetadataImport) {
    const metadataObj = {};

    if (title) {
      metadataObj.title = title;
    }

    Object.assign(metadataObj, metadata.basic);

    if (hasIcons) {
      metadataObj.icons = metadata.icons;
    }

    if (hasOpenGraph) {
      metadataObj.openGraph = metadata.openGraph;
    }

    if (hasTwitter) {
      metadataObj.twitter = metadata.twitter;
    }

    if (metadata.robots) {
      metadataObj.robots = metadata.robots;
    }

    if (Object.keys(metadata.alternates).length > 0) {
      metadataObj.alternates = metadata.alternates;
    }

    metadataCode += `export const metadata: Metadata = ${JSON.stringify(metadataObj, null, 2)};\n`;
  }

  // viewport export 생성
  if (needsViewportImport) {
    metadataCode += `\nexport const viewport: Viewport = ${JSON.stringify(viewport, null, 2)};\n`;
  }

  // <head> 태그 내용 정리
  // meta, title, link(icon) 태그는 제거하고 preconnect 등만 남김
  let newHeadContent = headContent;

  // title 태그 제거
  newHeadContent = newHeadContent.replace(/<title>[^<]*<\/title>/gi, '');

  // meta 태그 제거 (charset 제외)
  newHeadContent = newHeadContent.replace(/<meta\s+(?!.*charset)[^>]*\/?>/gi, '');

  // icon 관련 link 태그 제거
  newHeadContent = newHeadContent.replace(/<link\s+[^>]*rel=["'](icon|shortcut icon|apple-touch-icon)["'][^>]*\/?>/gi, '');

  // 주석 처리된 index.html 관련 주석 유지, 빈 줄 정리
  newHeadContent = newHeadContent
    .replace(/^\s*\n/gm, '')
    .trim();

  // preconnect 등 남은 태그가 있으면 유지, 없으면 간단하게
  // React: <head> 직후 줄바꿈/공백만 있는 텍스트 노드는 hydration 오류가 나므로,
  // `>` 다음에 공백 없이 주석·태그만 오도록 한 줄로 붙인다.
  if (otherTags.length > 0 || newHeadContent.includes('<link')) {
    const tagsCompact = newHeadContent
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('')
      // <head> 안에서 태그 사이 공백 텍스트 노드가 생기지 않도록 강제 압축
      .replace(/>\s+</g, '><');
    newHeadContent = `{/* 기타 head 태그 (preconnect 등) */}${tagsCompact}`;
  } else {
    newHeadContent = '{/* 메타데이터는 export const metadata로 이동됨 */}';
  }

  // 파일 내용 수정
  // 1. import 다음에 metadata export 추가
  const importEndMatch = content.match(/^(import[\s\S]*?;\n)(?=\n*(?:export|const|function|async|\/\/))/m);

  if (importEndMatch) {
    const insertPosition = importEndMatch.index + importEndMatch[0].length;
    content = content.slice(0, insertPosition) + '\n' + metadataCode + '\n' + content.slice(insertPosition);
  } else {
    // import가 없으면 파일 시작에 추가
    content = metadataCode + '\n' + content;
  }

  // 2. <head> 태그 내용 교체
  content = content.replace(
    /<head[^>]*>[\s\S]*?<\/head>/i,
    `<head>${newHeadContent}</head>`
  );

  await fs.writeFile(rootLayoutPath, content, 'utf-8');

  return {
    success: true,
    title,
    metadata,
    viewport,
  };
}

// ============================================================================
// 메인 함수
// ============================================================================

/**
 * 단일 페이지의 메타데이터 마이그레이션
 */
async function migratePageMetadata(projectRoot, pageFilePath, componentFilePath) {
  // ts-morph 프로젝트 설정
  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
  });

  // 컴포넌트 파일 파싱
  if (!fs.existsSync(componentFilePath)) {
    return { success: false, reason: 'component_not_found' };
  }

  const componentFile = project.addSourceFileAtPath(componentFilePath);

  // Helmet/Head 태그 찾기
  const helmetContent = findHelmetContent(componentFile);

  if (!helmetContent) {
    return { success: true, reason: 'no_helmet' };
  }

  // 동적 메타데이터 패턴 감지
  const dynamicPatterns = detectDynamicMetadataPattern(componentFile);

  // 정적 메타데이터 추출
  const { title, metadata, viewport, hasDynamicContent } = extractStaticMetadata(helmetContent.content);

  // 동적 메타데이터 표현식 추출
  const dynamicExpressions = extractDynamicMetadataExpressions(helmetContent.content);

  const hasDynamicExpressions =
    !!(
      dynamicExpressions.title ||
      dynamicExpressions.description ||
      Object.keys(dynamicExpressions.openGraph).length > 0 ||
      Object.keys(dynamicExpressions.twitter).length > 0
    );

  let metadataCode = '';
  let metadataType = 'static';
  const useAiForDynamicMetadata =
    dynamicPatterns.hasDataFetching ||
    dynamicPatterns.hasSearchParams ||
    dynamicPatterns.hasTitleTemplate ||
    hasDynamicContent ||
    hasDynamicExpressions;

  // 메타데이터 유형 결정 및 코드 생성
  if (useAiForDynamicMetadata) {
    metadataType = 'dynamic';
    metadataCode = generateDynamicMetadataStub(dynamicPatterns);
  } else {
    metadataCode = generateStaticMetadataCode(title, metadata, viewport);
  }

  if (!metadataCode) {
    return { success: true, reason: 'no_metadata' };
  }

  // page.tsx에 메타데이터 추가
  const added = await addMetadataToPage(pageFilePath, metadataCode);

  if (added) {
    if (useAiForDynamicMetadata) {
      const pageRel = path.relative(projectRoot, pageFilePath).split(path.sep).join('/');
      const componentRel = path.relative(projectRoot, componentFilePath).split(path.sep).join('/');
      const patternsJson = JSON.stringify(
        {
          hasDataFetching: dynamicPatterns.hasDataFetching,
          fetchFunction: dynamicPatterns.fetchFunction,
          hasSearchParams: dynamicPatterns.hasSearchParams,
          hasTitleTemplate: dynamicPatterns.hasTitleTemplate,
          titleTemplate: dynamicPatterns.titleTemplate,
          paramUsage: dynamicPatterns.paramUsage,
          hasDynamicContent,
          hasDynamicExpressions,
        },
        null,
        2
      );
      const helmetSnippet =
        helmetContent.content.length > 6000
          ? `${helmetContent.content.slice(0, 6000)}\n... (truncated)`
          : helmetContent.content;
      const dataVarHint = extractDataVariableName(dynamicExpressions);

      const candidateRelPaths = await collectMigrationCandidateRelPaths(projectRoot);

      await stopAndOfferGeminiApply({
        projectRoot,
        discoveryLine: `${pageRel} 에서 동적 메타데이터(generateMetadata)가 감지되었습니다.`,
        discoverySources: [pageRel, componentRel].filter(Boolean),
        instructionForAi: `Next.js App Router 마이그레이션입니다. 동적 메타데이터를 generateMetadata로 완성하세요.

- 수정 대상: ${pageRel} 의 export async function generateMetadata — 빈 title/description 및 서버에서 실행 가능한 데이터 로딩을 이 저장소의 기존 패턴(API 모듈, fetch 등)에 맞게 완성하세요.
- 참고: ${componentRel} 의 Helmet/Head 내부 JSX (아래 발췌). 동적 title·description·openGraph·twitter 등을 Metadata 타입에 맞게 반영하세요.

요구사항:
- 서버에서 실행 가능한 코드만 사용하세요. window, document 등 브라우저 전용 API는 쓰지 마세요.
- 파일에 이미 있는 generateMetadata 인자(params, searchParams)는 유지하고, 실제 동적 세그먼트·쿼리에 맞게 본문을 수정하세요.
- TODO 주석을 새로 넣지 마세요.

감지된 패턴(JSON):
${patternsJson}

추출된 동적 표현식(JSON):
${JSON.stringify(dynamicExpressions, null, 2)}

표현식 기준 데이터 루트 변수 추정(참고): "${dataVarHint}"

Helmet 내부 발췌:
${helmetSnippet}`,
        candidateRelPaths,
        manualGuideLines: [
          `1. 대상: ${pageRel}의 export async function generateMetadata 구현(현재 stub/빈 값).`,
          `2. ${componentRel}의 Helmet/Head 값을 다음처럼 Metadata return 객체로 채우세요: generateMetadata가 "return { title, description, alternates: { canonical }, openGraph: { title, description, url, images }, twitter: { card, title, description, images } }" 형태로 결과를 만들어 반환하도록 구성하고, 데이터는 서버 fetch/서버 유틸로 만든 뒤(window/document 금지) return만 사용하세요.`,
          `3. 완료 후: generateMetadata가 서버에서 동작 가능하도록 정리하고 저장하세요(브라우저 API/모듈 스코프 부작용 제거).`,
        ],
      });
    }

    await commentOutHelmet(componentFilePath, helmetContent);
  }

  return {
    success: true,
    metadataType,
    title,
    metadata,
  };
}

/**
 * import 경로를 절대 경로로 해석
 */
function resolveImportPath(importPath, fromFilePath, projectRoot) {
  let absolutePath;

  if (importPath.startsWith('.')) {
    // 상대 경로
    absolutePath = path.resolve(path.dirname(fromFilePath), importPath);
  } else if (importPath.startsWith('@/')) {
    // 알리아스 경로
    absolutePath = path.join(projectRoot, 'src', importPath.slice(2));
  } else {
    // node_modules 패키지
    return null;
  }

  // 확장자 추가 시도
  const extensions = ['.tsx', '.jsx', '.ts', '.js'];
  for (const ext of extensions) {
    const tryPath = absolutePath + ext;
    if (fs.existsSync(tryPath)) {
      return tryPath;
    }
  }

  // 이미 확장자가 있거나 디렉토리인 경우
  if (fs.existsSync(absolutePath)) {
    return absolutePath;
  }

  // index 파일 시도
  for (const ext of extensions) {
    const tryPath = path.join(absolutePath, `index${ext}`);
    if (fs.existsSync(tryPath)) {
      return tryPath;
    }
  }

  return null;
}

/**
 * 파일에서 모든 import된 컴포넌트 경로 추출
 */
function extractAllImports(fileContent) {
  const imports = [];
  
  // default import: import Component from '...'
  const defaultImportRegex = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  
  while ((match = defaultImportRegex.exec(fileContent)) !== null) {
    imports.push({
      name: match[1],
      path: match[2],
      type: 'default',
    });
  }

  // named import: import { Component } from '...'
  const namedImportRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  
  while ((match = namedImportRegex.exec(fileContent)) !== null) {
    const names = match[1].split(',').map(n => n.trim().split(' as ')[0].trim());
    for (const name of names) {
      imports.push({
        name,
        path: match[2],
        type: 'named',
      });
    }
  }

  return imports;
}

/**
 * 프로젝트 전체 메타데이터 마이그레이션
 */
async function migrateMetadata(projectRoot) {
  const appDir = path.join(projectRoot, 'src/app');

  if (!fs.existsSync(appDir)) {
    return;
  }

  // 0. 루트 layout.tsx의 <head> 태그 메타데이터 처리
  const rootLayoutResult = await migrateRootLayoutMetadata(projectRoot);

  // app 디렉토리 내 모든 page.tsx 및 layout.tsx 파일 찾기
  const targetFiles = {
    pages: [],
    layouts: [],
  };

  async function findTargetFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await findTargetFiles(fullPath);
      } else if (entry.name === 'page.tsx' || entry.name === 'page.jsx') {
        targetFiles.pages.push(fullPath);
      } else if (entry.name === 'layout.tsx' || entry.name === 'layout.jsx') {
        // 루트 layout.tsx는 제외 (위에서 별도 처리)
        const relativePath = path.relative(appDir, fullPath);
        if (relativePath !== 'layout.tsx' && relativePath !== 'layout.jsx') {
          targetFiles.layouts.push(fullPath);
        }
      }
    }
  }

  await findTargetFiles(appDir);

  const results = [];

  // 1. page.tsx 파일 처리
  for (const pageFile of targetFiles.pages) {
    const pageContent = await fs.readFile(pageFile, 'utf-8');
    const imports = extractAllImports(pageContent);

    for (const imp of imports) {
      const absoluteComponentPath = resolveImportPath(imp.path, pageFile, projectRoot);

      if (absoluteComponentPath && fs.existsSync(absoluteComponentPath)) {
        const result = await migratePageMetadata(projectRoot, pageFile, absoluteComponentPath);
        results.push({ 
          targetFile: pageFile, 
          targetType: 'page',
          componentPath: absoluteComponentPath, 
          ...result 
        });
      }
    }
  }

  // 2. layout.tsx 파일 처리
  for (const layoutFile of targetFiles.layouts) {
    const layoutContent = await fs.readFile(layoutFile, 'utf-8');
    const imports = extractAllImports(layoutContent);

    // layout.tsx에서 import된 컴포넌트들 중 Helmet이 있는 것 찾기
    for (const imp of imports) {
      const absoluteComponentPath = resolveImportPath(imp.path, layoutFile, projectRoot);

      if (absoluteComponentPath && fs.existsSync(absoluteComponentPath)) {
        // 컴포넌트 파일 내용 확인
        const componentContent = await fs.readFile(absoluteComponentPath, 'utf-8');
        
        // Helmet 태그가 있는지 확인
        if (componentContent.includes('<Helmet') || componentContent.includes('<Head')) {
          const result = await migratePageMetadata(projectRoot, layoutFile, absoluteComponentPath);
          results.push({ 
            targetFile: layoutFile, 
            targetType: 'layout',
            componentPath: absoluteComponentPath, 
            ...result 
          });
        }
      }
    }

    // layout.tsx 파일 자체에도 Helmet이 있을 수 있음 (직접 포함된 경우)
    if (layoutContent.includes('<Helmet') || layoutContent.includes('<Head')) {
      const result = await migratePageMetadata(projectRoot, layoutFile, layoutFile);
      results.push({ 
        targetFile: layoutFile, 
        targetType: 'layout',
        componentPath: layoutFile, 
        ...result 
      });
    }
  }

  // 결과 요약
  const successful = results.filter(r => r.success && r.metadataType);
  const staticCount = successful.filter(r => r.metadataType === 'static').length;
  const dynamicCount = successful.filter(r => r.metadataType === 'dynamic').length;
  return { rootLayoutResult, results };
}

// ============================================================================
// 모듈 내보내기
// ============================================================================

module.exports = {
  migrateMetadata,
  migratePageMetadata,
  migrateRootLayoutMetadata,
  extractStaticMetadata,
  extractMetadataFromHead,
  detectDynamicMetadataPattern,
  generateStaticMetadataCode,
  generateDynamicMetadataStub,
  // generateDynamicMetadataCode, // 레거시: 동적 메타데이터 AI 통합으로 미사용
  // generateTitleTemplateCode, // 레거시: 동적 메타데이터 AI 통합으로 미사용
  META_TAG_MAPPING,
  LINK_TAG_MAPPING,
};
