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

const STORAGE_KEYWORDS = ['localStorage', 'sessionStorage'];

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
 */
async function classifyStoreFiles(storeFiles) {
  const classified = {
    persistence: [],       // Case a: localStorage/sessionStorage 직접 사용
    volatile: [],          // Case b: 휘발성 (저장소 사용 안 함)
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
  const match = content.match(/export\s+const\s+(use\w+(?:Store)?)\s*=/);
  if (match) {
    return match[1];
  }

  // 파일명에서 추출 (authStore.ts -> useAuthStore)
  const fileName = path.basename(filePath, path.extname(filePath));
  const baseName = fileName.replace(/Store$/i, '');
  return `use${baseName.charAt(0).toUpperCase() + baseName.slice(1)}Store`;
}

/**
 * 스토어에서 localStorage 키 추출
 */
function extractStorageKey(content) {
  // localStorage.getItem('key') 또는 localStorage.setItem('key', ...)
  const match = content.match(/localStorage\.(getItem|setItem)\s*\(\s*['"]([^'"]+)['"]/);
  return match ? match[2] : 'store-data';
}

/**
 * 스토어에서 상태 키들 추출
 */
function extractStateKeys(content) {
  const keys = [];
  
  // create<...>((set) => ({ user: ..., isLoggedIn: ... })) 패턴에서 키 추출
  const statePattern = /create[^(]*\([^)]*\)\s*=>\s*\(\s*\{([^]*?)\}\s*\)\s*\)/;
  const match = content.match(statePattern);
  
  if (match) {
    const stateBody = match[1];
    // 첫 번째 레벨의 키만 추출 (중첩 객체 제외)
    const keyPattern = /^\s*(\w+)\s*:/gm;
    let keyMatch;
    while ((keyMatch = keyPattern.exec(stateBody)) !== null) {
      // 함수가 아닌 상태 키만 (login:, logout: 등 함수 제외)
      const key = keyMatch[1];
      // 해당 키가 함수인지 확인
      const afterKey = stateBody.slice(keyMatch.index + keyMatch[0].length);
      if (!afterKey.trim().startsWith('(') && !afterKey.trim().startsWith('async')) {
        keys.push(key);
      }
    }
  }

  return keys.length > 0 ? keys : ['data'];
}

// ============================================================================
// 2. Case a: 영구 데이터 스토어 변환
// ============================================================================

/**
 * 영구 데이터 스토어 변환 (Case a) - ts-morph 사용
 */
async function transformPersistenceStore(filePath, projectRoot) {
  console.log(`   📄 영구 데이터 스토어 변환: ${path.relative(projectRoot, filePath)}`);

  const project = new Project({
    useInMemoryFileSystem: false,
  });

  const sourceFile = project.addSourceFileAtPath(filePath);
  let content = sourceFile.getFullText();
  const storeName = extractStoreName(content, filePath);
  const storageKey = extractStorageKey(content);

  // 인터페이스에서 타입 정보 추출
  const fieldTypes = extractInterfaceFieldTypes(content);

  // 1. 인터페이스에 hydrate 메서드 시그니처 추가
  content = addHydrateToInterface(content);

  // 2. 모듈 최상위 localStorage 접근을 헬퍼 함수로 변환
  const { content: updatedContent, storageInfo } = transformTopLevelStorageToHelper(content, storageKey, fieldTypes);
  content = updatedContent;

  // 3. 모듈 최상위 변수를 참조하는 스토어 초기값 대체
  content = replaceStorageVariableReferences(content, storageInfo.relatedVars, fieldTypes);

  // 4. 스토어 내부 직접 getItem 초기값을 기본값으로 치환
  content = replaceGetItemInitialValues(content);

  // 5. setItem/removeItem을 window 체크로 래핑
  content = wrapStorageCallsWithWindowCheck(content);

  // 6. 헬퍼 함수를 사용하는 hydrate 함수 구현 추가
  content = addHelperBasedHydrateFunction(content, storageInfo);

  // Note: 자동 hydration은 providers.tsx에서 useEffect로 처리됨
  // 스토어 파일에 별도의 자동 hydration 코드를 추가하지 않음

  // 파일 저장
  await fs.writeFile(filePath, content);
  console.log(`   ✅ 변환 완료: ${storeName}`);

  return { storeName, filePath, type: 'persistence' };
}

/**
 * TypeScript 인터페이스에 hydrate 메서드 시그니처 추가
 */
function addHydrateToInterface(content) {
  // interface XxxState { ... } 또는 type XxxState = { ... } 패턴 찾기
  const interfacePattern = /(interface|type)\s+(\w+State)\s*(=\s*)?\{/g;
  let match;
  
  while ((match = interfacePattern.exec(content)) !== null) {
    const keyword = match[1]; // interface 또는 type
    const interfaceName = match[2];
    const startIndex = match.index;
    const braceStartIndex = match.index + match[0].length - 1;
    
    // 중괄호 매칭으로 인터페이스 끝 찾기
    let braceCount = 1;
    let endIndex = braceStartIndex + 1;
    
    while (braceCount > 0 && endIndex < content.length) {
      if (content[endIndex] === '{') braceCount++;
      else if (content[endIndex] === '}') braceCount--;
      endIndex++;
    }
    
    // 인터페이스 내용 추출
    const interfaceContent = content.slice(braceStartIndex, endIndex);
    
    // 이미 hydrate가 있으면 건너뜀
    if (interfaceContent.includes('hydrate:') || interfaceContent.includes('hydrate :')) {
      continue;
    }
    
    // 들여쓰기 감지 (첫 번째 멤버의 들여쓰기 사용)
    const indentMatch = interfaceContent.match(/\n(\s+)\w+/);
    const indent = indentMatch ? indentMatch[1] : '  ';
    
    // 닫는 중괄호 앞에 hydrate 추가
    const newInterfaceContent = interfaceContent.slice(0, -1) + 
      `${indent}hydrate: () => void\n` + 
      interfaceContent.slice(-1);
    
    content = content.slice(0, braceStartIndex) + newInterfaceContent + content.slice(endIndex);
    
    // 패턴의 lastIndex 업데이트 (내용이 변경되었으므로)
    interfacePattern.lastIndex = braceStartIndex + newInterfaceContent.length;
  }

  return content;
}

/**
 * 모듈 최상위의 localStorage 접근을 헬퍼 함수로 변환
 * 예: const savedUser = localStorage.getItem('key')
 *     const initialUser = savedUser ? JSON.parse(savedUser) : null
 * 변환 후:
 *     const getStoredUser = () => {
 *       if (typeof window === 'undefined') return null;
 *       const savedUser = localStorage.getItem('key');
 *       return savedUser ? JSON.parse(savedUser) : null;
 *     };
 */
function transformTopLevelStorageToHelper(content, storageKey, fieldTypes) {
  const storageAccessInfo = analyzeStorageAccess(content);
  
  if (storageAccessInfo.length === 0) {
    return { 
      content, 
      storageInfo: { relatedVars: [], helperFunctions: [] } 
    };
  }

  const helperFunctions = [];
  const relatedVars = [];
  let newContent = content;

  for (const info of storageAccessInfo) {
    // 헬퍼 함수 이름 생성 (예: savedUser -> getStoredUser)
    const helperName = generateHelperFunctionName(info.derivedVarName || info.storageVarName);
    
    // 반환 타입 결정
    const returnType = determineReturnType(info, fieldTypes);
    
    // 헬퍼 함수 생성
    const helperFunction = generateHelperFunction(helperName, info, returnType);
    helperFunctions.push({
      name: helperName,
      code: helperFunction,
      storageKey: info.storageKey,
      returnType,
      originalVarName: info.derivedVarName || info.storageVarName,
      relatedStateFields: info.relatedStateFields || []
    });

    // 관련 변수 수집
    relatedVars.push(info.storageVarName);
    if (info.derivedVarName) {
      relatedVars.push(info.derivedVarName);
    }

    // 원본 코드에서 해당 라인들 제거
    newContent = removeStorageLines(newContent, info);
  }

  // 헬퍼 함수들을 create 문 바로 앞에 삽입
  newContent = insertHelperFunctions(newContent, helperFunctions);

  return {
    content: newContent,
    storageInfo: {
      relatedVars,
      helperFunctions
    }
  };
}

/**
 * 모듈 최상위 localStorage 접근 분석
 */
function analyzeStorageAccess(content) {
  const results = [];
  const lines = content.split('\n');
  let inCreateBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // create 블록 감지
    if (trimmedLine.includes('create<') || trimmedLine.includes('create(')) {
      inCreateBlock = true;
    }
    if (inCreateBlock && trimmedLine.includes('));')) {
      inCreateBlock = false;
    }

    // create 블록 안은 건너뜀
    if (inCreateBlock) continue;

    // localStorage.getItem 패턴 찾기
    const storageMatch = trimmedLine.match(/^(const|let|var)\s+(\w+)\s*=\s*(localStorage|sessionStorage)\.getItem\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    
    if (storageMatch) {
      const storageVarName = storageMatch[2];
      const storageType = storageMatch[3];
      const storageKey = storageMatch[4];

      // 다음 줄에서 파생 변수 찾기 (예: const initialUser = savedUser ? JSON.parse(savedUser) : null)
      let derivedVarName = null;
      let defaultValue = null;
      let derivedLineIndex = -1;

      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nextLine = lines[j].trim();
        const derivedMatch = nextLine.match(new RegExp(`^(const|let|var)\\s+(\\w+)\\s*=\\s*${storageVarName}\\s*\\?\\s*JSON\\.parse\\s*\\(\\s*${storageVarName}\\s*\\)\\s*:\\s*([^;]+)`));
        
        if (derivedMatch) {
          derivedVarName = derivedMatch[2];
          defaultValue = derivedMatch[3].trim();
          derivedLineIndex = j;
          break;
        }
      }

      results.push({
        storageVarName,
        storageType,
        storageKey,
        derivedVarName,
        defaultValue,
        lineIndex: i,
        derivedLineIndex,
        relatedStateFields: findRelatedStateFields(content, derivedVarName || storageVarName)
      });
    }
  }

  return results;
}

/**
 * 관련된 상태 필드 찾기
 */
function findRelatedStateFields(content, varName) {
  const fields = [];
  
  // 스토어 내부에서 해당 변수를 사용하는 필드 찾기
  // 예: user: initialUser, isAuthenticated: !!initialUser
  const directPattern = new RegExp(`(\\w+):\\s*${varName}\\s*,`, 'g');
  const booleanPattern = new RegExp(`(\\w+):\\s*!!\\s*${varName}\\s*,`, 'g');
  
  let match;
  while ((match = directPattern.exec(content)) !== null) {
    fields.push({ name: match[1], derivation: 'direct' });
  }
  while ((match = booleanPattern.exec(content)) !== null) {
    if (!fields.find(f => f.name === match[1])) {
      fields.push({ name: match[1], derivation: 'boolean' });
    }
  }

  return fields;
}

/**
 * 헬퍼 함수 이름 생성
 */
function generateHelperFunctionName(varName) {
  // initialUser -> getStoredUser, savedFavorites -> getStoredFavorites
  const baseName = varName
    .replace(/^(initial|saved|stored)/, '')
    .replace(/^[a-z]/, c => c.toUpperCase());
  
  return `getStored${baseName}`;
}

/**
 * 반환 타입 결정
 */
function determineReturnType(info, fieldTypes) {
  // 관련 상태 필드의 타입 확인
  for (const field of info.relatedStateFields || []) {
    if (field.derivation === 'direct' && fieldTypes[field.name]) {
      return fieldTypes[field.name];
    }
  }

  // 기본값에서 타입 추론
  if (info.defaultValue) {
    if (info.defaultValue === '[]') return 'array';
    if (info.defaultValue === 'null') return 'null';
    if (info.defaultValue === 'false' || info.defaultValue === 'true') return 'boolean';
  }

  return 'null';
}

/**
 * 헬퍼 함수 생성
 */
function generateHelperFunction(helperName, info, returnType) {
  let defaultReturn = 'null';
  if (returnType === 'array' || returnType.endsWith('[]')) {
    defaultReturn = '[]';
  }

  return `// SSR 방어: localStorage 접근을 함수 내부로 이동
const ${helperName} = () => {
  if (typeof window === 'undefined') return ${defaultReturn};
  const ${info.storageVarName} = ${info.storageType}.getItem('${info.storageKey}');
  return ${info.storageVarName} ? JSON.parse(${info.storageVarName}) : ${defaultReturn};
};
`;
}

/**
 * 원본 코드에서 storage 관련 라인 제거
 */
function removeStorageLines(content, info) {
  const lines = content.split('\n');
  const linesToRemove = new Set([info.lineIndex]);
  
  if (info.derivedLineIndex !== -1) {
    linesToRemove.add(info.derivedLineIndex);
  }

  // 인접한 주석도 제거 (// Intentional SSR-breaking 등)
  if (info.lineIndex > 0) {
    const prevLine = lines[info.lineIndex - 1].trim();
    if (prevLine.startsWith('//') && (prevLine.includes('SSR') || prevLine.includes('localStorage'))) {
      linesToRemove.add(info.lineIndex - 1);
    }
  }

  const result = lines.filter((_, index) => !linesToRemove.has(index));
  return result.join('\n');
}

/**
 * 헬퍼 함수들을 create 문 앞에 삽입
 */
function insertHelperFunctions(content, helperFunctions) {
  if (helperFunctions.length === 0) return content;

  const helperCode = helperFunctions.map(h => h.code).join('\n');
  
  // export const useXxxStore = create 패턴 찾기
  const createPattern = /(\n)(export\s+const\s+use\w+Store\s*=\s*create)/;
  
  if (createPattern.test(content)) {
    content = content.replace(createPattern, `$1${helperCode}\n$2`);
  } else {
    // create( 패턴으로 fallback
    const fallbackPattern = /(const\s+use\w+Store\s*=\s*create)/;
    content = content.replace(fallbackPattern, `${helperCode}\n$1`);
  }

  return content;
}

/**
 * 인터페이스에서 필드별 타입 정보 추출
 * 예: interface MovieState { favorites: number[]; ... } -> { favorites: 'number[]' }
 */
function extractInterfaceFieldTypes(content) {
  const fieldTypes = {};

  // interface XxxState { ... } 패턴 찾기
  const interfacePattern = /(interface|type)\s+(\w+State)\s*(=\s*)?\{([^}]+)\}/gs;
  let interfaceMatch;

  while ((interfaceMatch = interfacePattern.exec(content)) !== null) {
    const interfaceBody = interfaceMatch[4];
    
    // 각 필드 타입 추출: fieldName: type
    const fieldPattern = /(\w+)\s*:\s*([^;\n]+)/g;
    let fieldMatch;

    while ((fieldMatch = fieldPattern.exec(interfaceBody)) !== null) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2].trim();
      fieldTypes[fieldName] = fieldType;
    }
  }

  return fieldTypes;
}

/**
 * 타입에 따른 기본값 결정
 */
function getDefaultValueForType(typeStr) {
  if (!typeStr) return 'null';

  const normalizedType = typeStr.replace(/\s+/g, ' ').trim();

  // 배열 타입: number[], string[], any[], Array<...>, etc.
  if (normalizedType.endsWith('[]') || normalizedType.startsWith('Array<')) {
    return '[]';
  }

  // boolean 타입
  if (normalizedType === 'boolean') {
    return 'false';
  }

  // number 타입
  if (normalizedType === 'number') {
    return '0';
  }

  // string 타입
  if (normalizedType === 'string') {
    return "''";
  }

  // null 가능 타입 (| null 포함) 또는 객체 타입
  if (normalizedType.includes('| null') || 
      normalizedType.includes('null |') ||
      normalizedType.startsWith('{') ||
      /^[A-Z]/.test(normalizedType)) { // 대문자로 시작하면 커스텀 타입/객체
    return 'null';
  }

  // 기본값
  return 'null';
}

/**
 * 모듈 최상위에서 선언된 변수를 참조하는 스토어 초기값 대체
 * 인터페이스 타입 정보를 기반으로 적절한 기본값 설정
 * 예: user: initialUser -> user: null (타입이 User | null인 경우)
 *     favorites: initialFavorites -> favorites: [] (타입이 number[]인 경우)
 */
function replaceStorageVariableReferences(content, storageRelatedVars, fieldTypes) {
  if (storageRelatedVars.length === 0) {
    return content;
  }

  // fieldTypes가 전달되지 않은 경우 추출
  if (!fieldTypes) {
    fieldTypes = extractInterfaceFieldTypes(content);
  }

  for (const varName of storageRelatedVars) {
    // 패턴 1: key: varName (직접 참조)
    content = content.replace(
      new RegExp(`(\\w+):\\s*${varName}\\s*,`, 'g'),
      (match, key) => {
        const defaultValue = getDefaultValueForType(fieldTypes[key]);
        return `${key}: ${defaultValue},`;
      }
    );

    // 패턴 2: key: !!varName (boolean 변환)
    content = content.replace(
      new RegExp(`(\\w+):\\s*!!\\s*${varName}\\s*,`, 'g'),
      '$1: false,'
    );

    // 패턴 3: key: varName ? JSON.parse(varName) : defaultValue (삼항 연산)
    content = content.replace(
      new RegExp(`(\\w+):\\s*${varName}\\s*\\?[^,]+,`, 'g'),
      (match, key) => {
        const defaultValue = getDefaultValueForType(fieldTypes[key]);
        return `${key}: ${defaultValue},`;
      }
    );

    // 패턴 4: key: JSON.parse(varName) (JSON 파싱)
    content = content.replace(
      new RegExp(`(\\w+):\\s*JSON\\.parse\\s*\\(\\s*${varName}\\s*\\)\\s*,`, 'g'),
      (match, key) => {
        const defaultValue = getDefaultValueForType(fieldTypes[key]);
        return `${key}: ${defaultValue},`;
      }
    );
  }

  return content;
}

/**
 * getItem 초기값을 기본값으로 치환 (스토어 내부 직접 사용 시)
 */
function replaceGetItemInitialValues(content) {
  // 패턴 1: JSON.parse(localStorage.getItem('key')) || defaultValue
  content = content.replace(
    /(\w+):\s*JSON\.parse\s*\(\s*localStorage\.getItem\s*\([^)]+\)\s*(?:!|\s)*\)\s*(\|\||&&|\?\?)\s*([\w\[\]'"]+)/g,
    (match, key, operator, defaultVal) => {
      let newDefault = 'null';
      if (defaultVal === '[]') newDefault = '[]';
      else if (defaultVal === 'false' || defaultVal === 'true') newDefault = 'false';
      else if (defaultVal.startsWith("'") || defaultVal.startsWith('"')) newDefault = "''";
      return `${key}: ${newDefault}`;
    }
  );

  // 패턴 2: !!localStorage.getItem('key')
  content = content.replace(
    /(\w+):\s*!!\s*localStorage\.getItem\s*\([^)]+\)/g,
    (match, key) => `${key}: false`
  );

  // 패턴 3: localStorage.getItem('key') 단독
  content = content.replace(
    /(\w+):\s*localStorage\.getItem\s*\([^)]+\)/g,
    (match, key) => `${key}: null`
  );

  return content;
}

/**
 * localStorage.setItem/removeItem 호출을 window 체크로 래핑
 */
function wrapStorageCallsWithWindowCheck(content) {
  const lines = content.split('\n');
  const result = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // localStorage.setItem 또는 removeItem이 있는지 확인
    if ((line.includes('localStorage.setItem') || line.includes('localStorage.removeItem'))) {
      // 이미 window 체크가 있는지 확인 (이전 3줄 체크)
      const previousLines = lines.slice(Math.max(0, i - 3), i).join('\n');
      if (previousLines.includes('typeof window')) {
        result.push(line);
        continue;
      }
      
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
 * 스토어에 hydrate 함수 추가
 */
function addHydrateFunctionToStore(content, storeName, storageKey, stateKeys) {
  // 이미 hydrate 구현이 있으면 건너뜀
  if (/hydrate\s*:\s*\(\s*\)\s*=>\s*\{/.test(content)) {
    return content;
  }

  // 상태 키별 hydrate 로직 생성
  const hydrateSetStatements = stateKeys.map(key => `${key}: JSON.parse(stored)`).join(', ');

  const hydrateFunction = `hydrate: () => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('${storageKey}');
      if (stored) {
        try {
          set({ ${hydrateSetStatements} });
        } catch (e) {
          console.error('Failed to hydrate ${storeName}:', e);
        }
      }
    }
  },
  `;

  // create 함수의 })) 또는 }); 패턴을 찾아서 그 앞에 hydrate 추가
  // 패턴: create<...>((set) => ({ ... })) 또는 create((set) => ({ ... }));
  
  // 방법 1: })) 패턴 (create 끝)
  if (/\}\s*\)\s*\)\s*;?\s*$/.test(content)) {
    content = content.replace(
      /(\s*)\}\s*\)\s*\)\s*;?\s*$/,
      `\n  ${hydrateFunction}$1}));`
    );
    return content;
  }

  // 방법 2: }); 패턴
  if (/\}\s*\)\s*;?\s*$/.test(content)) {
    content = content.replace(
      /(\s*)\}\s*\)\s*;?\s*$/,
      `\n  ${hydrateFunction}$1});`
    );
    return content;
  }

  // 방법 3: 역순으로 create 함수 블록을 찾아서 마지막 속성 뒤에 추가
  // create<AuthState>((set) => ({ ... })) 패턴에서 마지막 })의 위치 찾기
  const createMatch = content.match(/create\s*(?:<[^>]+>)?\s*\(\s*\(?set\)?\s*=>\s*\(\s*\{/);
  if (createMatch) {
    const createStart = createMatch.index + createMatch[0].length;
    
    // 중괄호 매칭으로 스토어 객체 끝 찾기
    let braceCount = 1;
    let i = createStart;
    
    while (braceCount > 0 && i < content.length) {
      if (content[i] === '{') braceCount++;
      else if (content[i] === '}') braceCount--;
      i++;
    }
    
    // 마지막 } 위치 (i-1)
    const objectEndIndex = i - 1;
    
    // 마지막 } 앞에 hydrate 함수 삽입
    content = content.slice(0, objectEndIndex) + 
      `\n  ${hydrateFunction}` + 
      content.slice(objectEndIndex);
  }

  return content;
}

/**
 * 헬퍼 함수를 사용하는 hydrate 함수 추가
 */
function addHelperBasedHydrateFunction(content, storageInfo) {
  // 이미 hydrate 구현이 있으면 건너뜀
  if (/hydrate\s*:\s*\(\s*\)\s*=>\s*\{/.test(content)) {
    return content;
  }

  const { helperFunctions } = storageInfo;
  
  if (!helperFunctions || helperFunctions.length === 0) {
    return content;
  }

  // hydrate 함수 내용 생성
  const hydrateStatements = [];
  
  for (const helper of helperFunctions) {
    // 헬퍼 함수 호출로 값 가져오기
    const varName = helper.originalVarName.replace(/^(initial|saved)/, '').toLowerCase();
    
    // 관련된 상태 필드들에 대한 set 구문 생성
    if (helper.relatedStateFields && helper.relatedStateFields.length > 0) {
      const setFields = helper.relatedStateFields.map(field => {
        if (field.derivation === 'boolean') {
          return `${field.name}: !!${varName}`;
        }
        return `${field.name}: ${varName}`;
      }).join(', ');
      
      hydrateStatements.push(`    const ${varName} = ${helper.name}();`);
      hydrateStatements.push(`    set({ ${setFields} });`);
    } else {
      // 관련 필드를 찾지 못한 경우, 변수명에서 추론
      hydrateStatements.push(`    const ${varName} = ${helper.name}();`);
      hydrateStatements.push(`    set({ ${varName} });`);
    }
  }

  const hydrateFunction = `// 클라이언트에서 hydration 시 호출
  hydrate: () => {
${hydrateStatements.join('\n')}
  },`;

  // create 함수의 첫 번째 속성 앞에 hydrate 추가 (순서: hydrate가 먼저 오도록)
  // 또는 user: null, 같은 초기값 뒤에 추가

  // 스토어 객체의 시작 찾기
  const createPattern = /create\s*(?:<[^>]+>)?\s*\(\s*\(?set\)?\s*=>\s*\(\s*\{/;
  const createMatch = content.match(createPattern);
  
  if (createMatch) {
    const createStart = createMatch.index + createMatch[0].length;
    
    // 중괄호 매칭으로 스토어 객체 끝 찾기
    let braceCount = 1;
    let i = createStart;
    
    while (braceCount > 0 && i < content.length) {
      if (content[i] === '{') braceCount++;
      else if (content[i] === '}') braceCount--;
      i++;
    }
    
    const objectEndIndex = i - 1;
    
    // 마지막 } 앞에 hydrate 함수 삽입
    content = content.slice(0, objectEndIndex) + 
      `\n  ${hydrateFunction}\n` + 
      content.slice(objectEndIndex);
  }

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

  // skipHydration: true 추가
  content = addSkipHydration(content);

  await fs.writeFile(filePath, content);
  console.log(`   ✅ 변환 완료: ${storeName} (skipHydration 설정)`);

  return { storeName, filePath, type: 'persistMiddleware' };
}

/**
 * persist 설정에 skipHydration: true 추가
 */
function addSkipHydration(content) {
  if (/skipHydration\s*:\s*true/.test(content)) {
    return content;
  }

  if (/skipHydration\s*:\s*false/.test(content)) {
    return content.replace(/skipHydration\s*:\s*false/, 'skipHydration: true');
  }

  // persist의 설정 객체에 skipHydration 추가
  // 패턴: { name: 'store-name' } -> { name: 'store-name', skipHydration: true }
  content = content.replace(
    /(\{\s*name\s*:\s*['"][^'"]+['"])(\s*,?\s*\})/,
    '$1, skipHydration: true$2'
  );

  // name이 마지막이 아닌 경우
  if (!content.includes('skipHydration')) {
    content = content.replace(
      /(\{\s*name\s*:\s*['"][^'"]+['"]\s*,)/,
      '$1 skipHydration: true,'
    );
  }

  return content;
}

// ============================================================================
// 4. Provider에 hydrate 트리거 주입 (ts-morph 사용)
// ============================================================================

/**
 * Provider 파일 경로 찾기
 */
function findProviderFile(projectRoot) {
  const possiblePaths = [
    path.join(projectRoot, 'src/app/providers.tsx'),
    path.join(projectRoot, 'src/app/providers.jsx'),
    path.join(projectRoot, 'src/app/Providers.tsx'),
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
 * Provider에 hydrate 트리거 주입 (ts-morph 사용)
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

  const project = new Project({
    useInMemoryFileSystem: false,
  });

  const sourceFile = project.addSourceFileAtPath(providerPath);

  // 1. 스토어 import 추가
  for (const store of stores) {
    const relativePath = path.relative(path.dirname(providerPath), store.filePath)
      .replace(/\\/g, '/')
      .replace(/\.(ts|tsx|js|jsx)$/, '');
    
    const importPath = relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
    
    // 이미 import되어 있는지 확인
    const existingImport = sourceFile.getImportDeclaration(decl => 
      decl.getModuleSpecifierValue() === importPath
    );
    
    if (!existingImport) {
      sourceFile.addImportDeclaration({
        namedImports: [store.storeName],
        moduleSpecifier: importPath,
      });
    }
  }

  // 2. useEffect import 확인 및 추가
  const reactImport = sourceFile.getImportDeclaration(decl => 
    decl.getModuleSpecifierValue() === 'react'
  );

  if (reactImport) {
    const namedImports = reactImport.getNamedImports();
    const hasUseEffect = namedImports.some(imp => imp.getName() === 'useEffect');
    if (!hasUseEffect) {
      reactImport.addNamedImport('useEffect');
    }
  } else {
    // react import가 없으면 추가
    const hasUseEffectImport = sourceFile.getImportDeclarations().some(decl => 
      decl.getNamedImports().some(imp => imp.getName() === 'useEffect')
    );
    if (!hasUseEffectImport) {
      sourceFile.addImportDeclaration({
        namedImports: ['useEffect'],
        moduleSpecifier: 'react',
      });
    }
  }

  // 3. Providers 함수 찾기
  let providersFunction = sourceFile.getFunction('Providers');
  
  // 화살표 함수인 경우
  if (!providersFunction) {
    const providersVar = sourceFile.getVariableDeclaration('Providers');
    if (providersVar) {
      const initializer = providersVar.getInitializer();
      if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
        // 화살표 함수는 직접 수정이 어려우므로 텍스트 기반으로 처리
        await sourceFile.save();
        let content = await fs.readFile(providerPath, 'utf-8');
        content = injectUseEffectTextBased(content, stores);
        await fs.writeFile(providerPath, content);
        console.log(`   ✅ Provider hydrate 트리거 주입 완료`);
        return;
      }
    }
  }

  // function 선언인 경우도 텍스트 기반으로 처리 (더 안전함)
  await sourceFile.save();
  let content = await fs.readFile(providerPath, 'utf-8');
  content = injectUseEffectTextBased(content, stores);
  await fs.writeFile(providerPath, content);
  console.log(`   ✅ Provider hydrate 트리거 주입 완료`);
}

/**
 * 텍스트 기반 useEffect 주입 (더 정확한 위치에 삽입)
 */
function injectUseEffectTextBased(content, stores) {
  // hydrate 호출 코드 생성
  const hydrateCalls = stores.map(store => {
    if (store.type === 'persistence') {
      return `    ${store.storeName}.getState().hydrate();`;
    } else if (store.type === 'persistMiddleware') {
      return `    ${store.storeName}.persist.rehydrate();`;
    }
    return '';
  }).filter(Boolean);

  // 이미 useEffect가 있고 hydrate 호출이 있는지 확인
  for (const call of hydrateCalls) {
    if (content.includes(call.trim())) {
      // 이미 있으면 제거 (중복 방지)
      hydrateCalls.splice(hydrateCalls.indexOf(call), 1);
    }
  }

  if (hydrateCalls.length === 0) {
    return content;
  }

  const useEffectCode = `
  useEffect(() => {
${hydrateCalls.join('\n')}
  }, []);
`;

  // 기존 useEffect가 있는지 확인
  if (content.includes('useEffect(() => {')) {
    // 기존 useEffect 내부에 hydrate 호출 추가
    content = content.replace(
      /(useEffect\(\(\)\s*=>\s*\{)/,
      `$1\n${hydrateCalls.join('\n')}`
    );
    return content;
  }

  // return 문 바로 앞에 useEffect 추가
  // 방법 1: return ( 패턴 앞에 추가
  if (content.includes('return (')) {
    content = content.replace(
      /(\s+)(return\s*\()/,
      `$1${useEffectCode}$1$2`
    );
    return content;
  }

  // 방법 2: return <Fragment> 또는 return <> 패턴
  if (content.match(/return\s*<[A-Za-z>]/)) {
    content = content.replace(
      /(\s+)(return\s*<)/,
      `$1${useEffectCode}$1$2`
    );
    return content;
  }

  return content;
}

// ============================================================================
// 5. 휘발성 스토어 처리 (Case b)
// ============================================================================

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
    try {
      const result = await transformPersistenceStore(filePath, projectRoot);
      transformedStores.push(result);
    } catch (error) {
      console.error(`   ❌ 스토어 변환 실패 (${filePath}):`, error.message);
    }
  }

  // 4. Case c: Persist 미들웨어 스토어 변환
  for (const filePath of classified.persistMiddleware) {
    try {
      const result = await transformPersistMiddlewareStore(filePath, projectRoot);
      transformedStores.push(result);
    } catch (error) {
      console.error(`   ❌ 스토어 변환 실패 (${filePath}):`, error.message);
    }
  }

  // 5. Case b: 휘발성 스토어 보고
  reportVolatileStores(classified.volatile, projectRoot);

  // 6. Provider에 hydrate 트리거 주입
  await injectHydrateToProvider(projectRoot, transformedStores);

  // 결과 반환 (완료 메시지와 요약은 step5/index.cjs에서 출력)
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
