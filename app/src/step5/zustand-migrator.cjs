// src/step5/zustand-migrator.cjs
// Zustand 상태 관리 마이그레이션 모듈
// - Case a: 영구 데이터 (localStorage/sessionStorage 직접 사용)
// - Case b: 휘발성 데이터 (UI State) - 변경 없음
// - Case c: Persist 미들웨어 사용

const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');

// ============================================================================
// 상수 정의
// ============================================================================

/**
 * 영구 저장소 키워드
 */
const STORAGE_KEYWORDS = ['localStorage', 'sessionStorage'];

/**
 * Persist 미들웨어 키워드
 */
const PERSIST_KEYWORDS = ['persist'];

/**
 * 초기값 타입별 기본값 매핑
 */
const DEFAULT_VALUES = {
  object: 'null',
  boolean: 'false',
  array: '[]',
  string: "''",
  number: '0',
};

// ============================================================================
// 1. 대상 파일 분석 및 분류
// ============================================================================

/**
 * stores 디렉토리에서 모든 스토어 파일 찾기
 */
async function findStoreFiles(projectRoot) {
  const storesDir = path.join(projectRoot, 'src/stores');
  
  if (!fs.existsSync(storesDir)) {
    console.log('   ⚠️ src/stores 디렉토리가 없습니다.');
    return [];
  }

  const files = [];
  const entries = await fs.readdir(storesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && /\.(ts|js|tsx|jsx)$/.test(entry.name)) {
      files.push(path.join(storesDir, entry.name));
    }
  }

  return files;
}

/**
 * 스토어 파일 분류
 * @returns {{ persistence: string[], volatile: string[], persistMiddleware: string[] }}
 */
async function classifyStoreFiles(storeFiles) {
  const classified = {
    persistence: [],      // Case a: localStorage/sessionStorage 직접 사용
    volatile: [],         // Case b: 휘발성 (저장소 사용 안 함)
    persistMiddleware: [], // Case c: Persist 미들웨어 사용
  };

  for (const filePath of storeFiles) {
    const content = await fs.readFile(filePath, 'utf-8');

    // Case c: Persist 미들웨어 사용 여부 확인
    const hasPersistImport = /import\s*{[^}]*persist[^}]*}\s*from\s*['"]zustand\/middleware['"]/.test(content);
    const hasPersistWrapper = /create\s*\(\s*persist\s*\(/.test(content) || 
                              /create\s*<[^>]*>\s*\(\s*persist\s*\(/.test(content);

    if (hasPersistImport && hasPersistWrapper) {
      classified.persistMiddleware.push(filePath);
      continue;
    }

    // Case a: localStorage/sessionStorage 직접 사용 여부 확인
    const usesStorage = STORAGE_KEYWORDS.some(keyword => content.includes(keyword));

    if (usesStorage) {
      classified.persistence.push(filePath);
    } else {
      // Case b: 휘발성 데이터
      classified.volatile.push(filePath);
    }
  }

  return classified;
}

/**
 * 스토어 이름 추출 (파일에서 export된 훅 이름)
 */
function extractStoreName(content, filePath) {
  // export const useAuthStore = create(...) 패턴
  const match = content.match(/export\s+const\s+(use\w+Store)\s*=/);
  if (match) {
    return match[1];
  }

  // 파일명에서 추출 (authStore.ts -> useAuthStore)
  const fileName = path.basename(filePath, path.extname(filePath));
  const baseName = fileName.replace(/Store$/i, '');
  return `use${baseName.charAt(0).toUpperCase() + baseName.slice(1)}Store`;
}

// ============================================================================
// 2. Case a: 영구 데이터 스토어 변환
// ============================================================================

/**
 * getItem 호출의 초기값 타입 추론 및 기본값 반환
 */
function inferDefaultValue(expression) {
  const text = expression.toLowerCase();

  // JSON.parse가 있으면 객체/배열일 가능성
  if (text.includes('json.parse')) {
    // || [] 또는 || null 패턴으로 타입 추론
    if (text.includes('|| []') || text.includes('?? []')) {
      return DEFAULT_VALUES.array;
    }
    if (text.includes('|| null') || text.includes('?? null')) {
      return DEFAULT_VALUES.object;
    }
    // 기본적으로 객체로 추론
    return DEFAULT_VALUES.object;
  }

  // Boolean 패턴
  if (text.includes('!!') || text.includes('boolean') || 
      text.includes('isloggedin') || text.includes('isopen')) {
    return DEFAULT_VALUES.boolean;
  }

  // 기본값
  return DEFAULT_VALUES.object;
}

/**
 * 영구 데이터 스토어 변환 (Case a)
 */
async function transformPersistenceStore(filePath, projectRoot) {
  console.log(`   📄 영구 데이터 스토어 변환: ${path.relative(projectRoot, filePath)}`);

  let content = await fs.readFile(filePath, 'utf-8');
  const storeName = extractStoreName(content, filePath);

  // 1. getItem 초기값을 기본값으로 치환
  // 패턴: user: JSON.parse(localStorage.getItem('user')) || null
  content = content.replace(
    /(\w+):\s*JSON\.parse\s*\(\s*localStorage\.getItem\s*\([^)]+\)\s*\)\s*(\|\||&&|\?\?)\s*(\w+|\[\]|null|'[^']*'|"[^"]*")/g,
    (match, key, operator, defaultVal) => {
      // 타입에 맞는 기본값 사용
      let newDefault = defaultVal;
      if (defaultVal === 'null' || defaultVal.includes('null')) {
        newDefault = 'null';
      } else if (defaultVal === '[]') {
        newDefault = '[]';
      } else if (defaultVal === 'false' || defaultVal === 'true') {
        newDefault = 'false';
      }
      return `${key}: ${newDefault}`;
    }
  );

  // 2. !!localStorage.getItem 패턴 치환 (boolean)
  content = content.replace(
    /(\w+):\s*!!\s*localStorage\.getItem\s*\([^)]+\)/g,
    (match, key) => `${key}: false`
  );

  // 3. localStorage.getItem 단독 사용 치환
  content = content.replace(
    /(\w+):\s*localStorage\.getItem\s*\([^)]+\)/g,
    (match, key) => `${key}: null`
  );

  // 4. setItem/removeItem을 window 체크로 래핑
  content = wrapStorageCallsWithWindowCheck(content);

  // 5. hydrate 함수 추가
  content = addHydrateFunction(content, storeName);

  await fs.writeFile(filePath, content);
  console.log(`   ✅ 변환 완료: ${storeName}`);

  return { storeName, filePath, type: 'persistence' };
}

/**
 * localStorage.setItem/removeItem 호출을 window 체크로 래핑
 */
function wrapStorageCallsWithWindowCheck(content) {
  // 이미 window 체크가 있는 경우는 건너뜀
  const storageCallPattern = /(?<!if\s*\(\s*typeof\s+window\s*!==?\s*['"]undefined['"]\s*\)\s*\{\s*)localStorage\.(setItem|removeItem)\s*\([^)]+\)\s*;?/g;

  // 함수 내부의 storage 호출 찾기
  const lines = content.split('\n');
  const result = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // localStorage.setItem 또는 removeItem이 있고, 이미 window 체크가 없는 경우
    if ((line.includes('localStorage.setItem') || line.includes('localStorage.removeItem')) &&
        !lines.slice(Math.max(0, i - 3), i).some(l => l.includes('typeof window'))) {
      
      const indent = line.match(/^(\s*)/)[1];
      const trimmedLine = line.trim();
      
      result.push(`${indent}if (typeof window !== 'undefined') {`);
      result.push(`${indent}  ${trimmedLine}`);
      result.push(`${indent}}`);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

/**
 * hydrate 함수 추가
 */
function addHydrateFunction(content, storeName) {
  // 이미 hydrate가 있는지 확인
  if (content.includes('hydrate:') || content.includes('hydrate :')) {
    return content;
  }

  // localStorage.getItem 키 추출
  const storageKeyMatch = content.match(/localStorage\.getItem\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  const storageKey = storageKeyMatch ? storageKeyMatch[1] : 'store';

  // 상태 키 추출 (첫 번째 상태 속성)
  const stateKeyMatch = content.match(/create[^(]*\(\s*\(?set\)?\s*=>\s*\(\s*{\s*(\w+):/);
  const stateKey = stateKeyMatch ? stateKeyMatch[1] : 'data';

  const hydrateFunction = `
  hydrate: () => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('${storageKey}');
      if (stored) {
        try {
          set({ ${stateKey}: JSON.parse(stored) });
        } catch (e) {
          console.error('Failed to hydrate ${storeName}:', e);
        }
      }
    }
  },`;

  // create 함수의 마지막 속성 뒤에 추가
  // 패턴: })) 또는 }); 앞에 삽입
  content = content.replace(
    /(\s*)(}\s*\)\s*\)?\s*;?\s*)$/,
    `$1${hydrateFunction}$1$2`
  );

  return content;
}

// ============================================================================
// 3. Case c: Persist 미들웨어 스토어 변환
// ============================================================================

/**
 * Persist 미들웨어 스토어 변환 (Case c)
 */
async function transformPersistMiddlewareStore(filePath, projectRoot) {
  console.log(`   📄 Persist 미들웨어 스토어 변환: ${path.relative(projectRoot, filePath)}`);

  let content = await fs.readFile(filePath, 'utf-8');
  const storeName = extractStoreName(content, filePath);

  // skipHydration: true 추가 또는 수정
  content = addSkipHydration(content);

  await fs.writeFile(filePath, content);
  console.log(`   ✅ 변환 완료: ${storeName} (skipHydration 설정)`);

  return { storeName, filePath, type: 'persistMiddleware' };
}

/**
 * persist 설정에 skipHydration: true 추가
 */
function addSkipHydration(content) {
  // 이미 skipHydration: true가 있는지 확인
  if (/skipHydration\s*:\s*true/.test(content)) {
    return content;
  }

  // skipHydration: false를 true로 변경
  if (/skipHydration\s*:\s*false/.test(content)) {
    return content.replace(/skipHydration\s*:\s*false/, 'skipHydration: true');
  }

  // persist의 설정 객체에 skipHydration 추가
  // 패턴: persist(..., { name: '...' }) -> persist(..., { name: '...', skipHydration: true })
  
  // 방법 1: name: '...' 뒤에 추가
  if (/persist\s*\([^,]+,\s*\{[^}]*name\s*:\s*['"][^'"]+['"]/.test(content)) {
    content = content.replace(
      /(persist\s*\([^,]+,\s*\{[^}]*name\s*:\s*['"][^'"]+['"])(\s*,?\s*\})/,
      '$1, skipHydration: true$2'
    );
    return content;
  }

  // 방법 2: 설정 객체가 있는 경우 첫 번째 속성 뒤에 추가
  content = content.replace(
    /(persist\s*\([^,]+,\s*\{\s*)(\w+\s*:)/,
    '$1skipHydration: true, $2'
  );

  return content;
}

// ============================================================================
// 4. Provider에 hydrate 트리거 주입
// ============================================================================

/**
 * Provider 파일 경로 찾기
 */
function findProviderFile(projectRoot) {
  const possiblePaths = [
    path.join(projectRoot, 'src/app/providers.tsx'),
    path.join(projectRoot, 'src/app/providers.jsx'),
    path.join(projectRoot, 'src/components/providers/Provider.tsx'),
    path.join(projectRoot, 'src/components/providers/Provider.jsx'),
    path.join(projectRoot, 'src/providers/Provider.tsx'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Provider에 hydrate 트리거 주입
 */
async function injectHydrateToProvider(projectRoot, stores) {
  if (stores.length === 0) {
    return;
  }

  const providerPath = findProviderFile(projectRoot);
  
  if (!providerPath) {
    console.log('   ⚠️ Provider 파일을 찾을 수 없습니다. 수동으로 hydrate 호출을 추가하세요.');
    return;
  }

  console.log(`   📄 Provider에 hydrate 트리거 주입: ${path.relative(projectRoot, providerPath)}`);

  let content = await fs.readFile(providerPath, 'utf-8');

  // 1. 스토어 import 추가
  const imports = [];
  for (const store of stores) {
    const relativePath = path.relative(path.dirname(providerPath), store.filePath)
      .replace(/\\/g, '/')
      .replace(/\.(ts|tsx|js|jsx)$/, '');
    
    const importPath = relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
    const importStatement = `import { ${store.storeName} } from '${importPath}';`;
    
    if (!content.includes(store.storeName)) {
      imports.push(importStatement);
    }
  }

  // import 문 추가 (기존 import 뒤에)
  if (imports.length > 0) {
    const lastImportMatch = content.match(/^import .+$/gm);
    if (lastImportMatch) {
      const lastImport = lastImportMatch[lastImportMatch.length - 1];
      content = content.replace(
        lastImport,
        `${lastImport}\n${imports.join('\n')}`
      );
    } else {
      content = imports.join('\n') + '\n\n' + content;
    }
  }

  // 2. useEffect import 확인 및 추가
  if (!content.includes('useEffect')) {
    content = content.replace(
      /import React/,
      "import React, { useEffect }"
    );
    // React import가 없는 경우
    if (!content.includes('useEffect')) {
      content = `import { useEffect } from 'react';\n` + content;
    }
  }

  // 3. useEffect 내부에 hydrate 호출 추가
  const hydrateCallsCode = stores.map(store => {
    if (store.type === 'persistence') {
      return `    ${store.storeName}.getState().hydrate();`;
    } else if (store.type === 'persistMiddleware') {
      return `    ${store.storeName}.persist.rehydrate();`;
    }
    return '';
  }).filter(Boolean).join('\n');

  // 기존 useEffect가 있는지 확인
  if (content.includes('useEffect(() => {')) {
    // 기존 useEffect 내부에 추가 (중복 체크)
    const existingEffect = content.match(/useEffect\(\(\)\s*=>\s*\{([^}]*)\}/);
    if (existingEffect) {
      let effectBody = existingEffect[1];
      
      for (const store of stores) {
        const hydrateCall = store.type === 'persistence' 
          ? `${store.storeName}.getState().hydrate()`
          : `${store.storeName}.persist.rehydrate()`;
        
        if (!effectBody.includes(hydrateCall)) {
          effectBody = `\n${hydrateCallsCode}\n${effectBody}`;
        }
      }

      content = content.replace(
        /useEffect\(\(\)\s*=>\s*\{[^}]*\}/,
        `useEffect(() => {${effectBody}}`
      );
    }
  } else {
    // 새 useEffect 추가
    const useEffectCode = `
  useEffect(() => {
${hydrateCallsCode}
  }, []);
`;

    // Providers 함수 내부 첫 번째 return 앞에 추가
    content = content.replace(
      /(function\s+Providers[^{]*\{)/,
      `$1${useEffectCode}`
    );

    // 화살표 함수인 경우
    if (!content.includes('useEffect')) {
      content = content.replace(
        /(export\s+(?:const|function)\s+Providers[^=]*=\s*\([^)]*\)\s*(?::\s*[^=]+)?\s*=>\s*\{)/,
        `$1${useEffectCode}`
      );
    }
  }

  await fs.writeFile(providerPath, content);
  console.log(`   ✅ Provider hydrate 트리거 주입 완료`);
}

// ============================================================================
// 5. 휘발성 스토어 처리 (Case b)
// ============================================================================

/**
 * 휘발성 스토어는 변경 없이 유지
 * 단, 사용하는 컴포넌트가 'use client'를 가지고 있는지 확인하는 로그만 출력
 */
function reportVolatileStores(stores, projectRoot) {
  if (stores.length === 0) return;

  console.log(`\n   ℹ️ 휘발성 스토어 (변경 없음):`);
  for (const filePath of stores) {
    console.log(`      - ${path.relative(projectRoot, filePath)}`);
  }
  console.log(`      → 이 스토어들은 'use client' 컴포넌트에서만 사용해야 합니다.`);
}

// ============================================================================
// 메인 함수
// ============================================================================

/**
 * Zustand 스토어 마이그레이션 메인 함수
 */
async function migrateZustandStores(projectRoot) {
  console.log('🐻 Zustand 스토어 마이그레이션 시작...');

  // 1. 스토어 파일 찾기
  const storeFiles = await findStoreFiles(projectRoot);
  
  if (storeFiles.length === 0) {
    console.log('   ⚠️ Zustand 스토어 파일이 없습니다.');
    return;
  }

  console.log(`   📁 발견된 스토어 파일: ${storeFiles.length}개`);

  // 2. 스토어 분류
  const classified = await classifyStoreFiles(storeFiles);
  
  console.log(`   📊 분류 결과:`);
  console.log(`      - 영구 데이터 (localStorage): ${classified.persistence.length}개`);
  console.log(`      - 휘발성 데이터 (UI State): ${classified.volatile.length}개`);
  console.log(`      - Persist 미들웨어: ${classified.persistMiddleware.length}개`);

  const transformedStores = [];

  // 3. Case a: 영구 데이터 스토어 변환
  for (const filePath of classified.persistence) {
    const result = await transformPersistenceStore(filePath, projectRoot);
    transformedStores.push(result);
  }

  // 4. Case c: Persist 미들웨어 스토어 변환
  for (const filePath of classified.persistMiddleware) {
    const result = await transformPersistMiddlewareStore(filePath, projectRoot);
    transformedStores.push(result);
  }

  // 5. Case b: 휘발성 스토어 보고
  reportVolatileStores(classified.volatile, projectRoot);

  // 6. Provider에 hydrate 트리거 주입
  await injectHydrateToProvider(projectRoot, transformedStores);

  // 결과 요약
  console.log(`\n✅ Zustand 스토어 마이그레이션 완료:`);
  console.log(`   - 변환된 스토어: ${transformedStores.length}개`);
  console.log(`   - 유지된 스토어: ${classified.volatile.length}개`);

  return {
    transformed: transformedStores,
    volatile: classified.volatile,
  };
}

// ============================================================================
// 모듈 내보내기
// ============================================================================

module.exports = {
  migrateZustandStores,
  classifyStoreFiles,
  transformPersistenceStore,
  transformPersistMiddlewareStore,
  injectHydrateToProvider,
  findStoreFiles,
};
