// src/step5/useclient-migrator.cjs
// "use client" 지시문 추가 모듈

const fs = require('fs-extra');
const path = require('path');

//=========================================================
//"use client" 마이그레이션 메인 함수
//=========================================================
async function migrateUseClient(projectRoot) {
  // Case a: Client Component 판별 후 "use client" 추가
  await addUseClientToClientComponents(projectRoot);
  
  // Case b: 클라이언트 fetch 패턴 존재 시 "use client" 추가
  await addUseClientToClientFetchPatterns(projectRoot);
}

//=========================================================
//Case a: Client Component 판별 후 "use client" 추가
//=========================================================
async function addUseClientToClientComponents(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const srcAppDir = path.join(srcDir, 'app');

  if (!fs.existsSync(srcDir)) {
    return;
  }

  // 1. src/ 하위 .tsx, .ts 파일 찾기 (src/app 제외)
  async function findTsFiles(dir, excludeDir) {
    const files = [];
    const excludePath = path.resolve(excludeDir);

    if (!fs.existsSync(dir)) {
      return files;
    }

    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const resolvedPath = path.resolve(fullPath);

      // src/app 디렉터리는 제외
      if (resolvedPath.startsWith(excludePath)) {
        continue;
      }

      if (item.isDirectory()) {
        // node_modules, .next 등 제외
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath, excludeDir);
          files.push(...subFiles);
        }
      } else if (item.isFile() && /\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 2. 파일 검사 및 "use client" 추가
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');

    // 3. "use client"가 이미 존재하는지 확인
    if (content.trim().startsWith('"use client";') || content.trim().startsWith("'use client';")) {
      return; // 이미 존재하면 중복 추가하지 않음
    }

    // 2. Client Component 판별
    const isClientComponent = checkClientComponent(content);

    if (isClientComponent) {
      // 4. "use client" 추가 (import 문보다 위)
      content = addUseClient(content);
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  // 2. Client Component 판별
  function checkClientComponent(content) {
    // 2.1 React Hook import 또는 호출
    if (checkReactHooks(content)) {
      return true;
    }

    // 2.2 React DOM Client API 사용
    if (checkReactDOMClientAPI(content)) {
      return true;
    }

    // 2.3 JSX 이벤트 핸들러 속성 존재
    if (checkEventHandlers(content)) {
      return true;
    }

    // 2.4 브라우저 전용 API 사용
    if (checkBrowserAPIs(content)) {
      return true;
    }

    // 2.5 상태 관리 라이브러리 사용
    if (checkStateManagementLibraries(content)) {
      return true;
    }

    return false;
  }

  // 2.1 React Hook import 또는 호출
  function checkReactHooks(content) {
    const hooks = [
      'useState',
      'useEffect',
      'useLayoutEffect',
      'useInsertionEffect',
      'useRef',
      'useImperativeHandle',
      'useMemo',
      'useCallback',
      'useReducer',
      'useContext',
      'useId',
      'useDeferredValue',
      'useTransition',
      'useSyncExternalStore',
      'useDebugValue',
    ];

    for (const hook of hooks) {
      // import 또는 호출 패턴 확인
      const importPattern = new RegExp(`import\\s+.*\\b${hook}\\b.*from`, 'i');
      const callPattern = new RegExp(`\\b${hook}\\s*\\(`, 'i');
      
      if (importPattern.test(content) || callPattern.test(content)) {
        return true;
      }
    }

    return false;
  }

  // 2.2 React DOM Client API 사용
  function checkReactDOMClientAPI(content) {
    const apis = ['createPortal', 'flushSync'];

    for (const api of apis) {
      // import 또는 호출 패턴 확인
      const importPattern = new RegExp(`import\\s+.*\\b${api}\\b.*from`, 'i');
      const callPattern = new RegExp(`\\b${api}\\s*\\(`, 'i');
      
      if (importPattern.test(content) || callPattern.test(content)) {
        return true;
      }
    }

    return false;
  }

  // 2.3 JSX 이벤트 핸들러 속성 존재
  function checkEventHandlers(content) {
    const eventHandlers = [
      'onClick',
      'onDoubleClick',
      'onMouseDown',
      'onMouseUp',
      'onMouseEnter',
      'onMouseLeave',
      'onMouseMove',
      'onMouseOver',
      'onMouseOut',
      'onContextMenu',
      'onPointerDown',
      'onPointerUp',
      'onPointerMove',
      'onPointerEnter',
      'onPointerLeave',
      'onPointerOver',
      'onPointerOut',
      'onGotPointerCapture',
      'onLostPointerCapture',
      'onTouchStart',
      'onTouchMove',
      'onTouchEnd',
      'onTouchCancel',
      'onKeyDown',
      'onKeyUp',
      'onKeyPress',
      'onFocus',
      'onBlur',
      'onChange',
      'onInput',
      'onSubmit',
      'onReset',
      'onInvalid',
      'onScroll',
      'onWheel',
      'onDrag',
      'onDragStart',
      'onDragEnd',
      'onDragEnter',
      'onDragLeave',
      'onDragOver',
      'onDrop',
      'onAnimationStart',
      'onAnimationEnd',
      'onAnimationIteration',
      'onTransitionEnd',
      'onPlay',
      'onPause',
      'onEnded',
      'onTimeUpdate',
      'onVolumeChange',
      'onSeeking',
      'onSeeked',
      'onLoadedData',
      'onLoadedMetadata',
      'onLoadStart',
      'onCanPlay',
      'onCanPlayThrough',
      'onWaiting',
      'onRateChange',
      'onDurationChange',
      'onProgress',
      'onStalled',
      'onSuspend',
      'onEmptied',
      'onAbort',
      'onError',
      'onCopy',
      'onCut',
      'onPaste',
      'onCompositionStart',
      'onCompositionUpdate',
      'onCompositionEnd',
    ];

    for (const handler of eventHandlers) {
      // JSX 속성 패턴 확인 (= 또는 { 로 시작)
      const pattern = new RegExp(`\\b${handler}\\s*[={]`, 'i');
      if (pattern.test(content)) {
        return true;
      }
    }

    return false;
  }

  // 2.4 브라우저 전용 API 사용
  function checkBrowserAPIs(content) {
    const browserAPIs = [
      'window',
      'document',
      'navigator',
      'location',
      'history',
      'screen',
      'devicePixelRatio',
      'localStorage',
      'sessionStorage',
      'getComputedStyle',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'IntersectionObserver',
      'ResizeObserver',
      'MutationObserver',
      'matchMedia',
      'File',
      'FileReader',
      'Blob',
      'URL.createObjectURL',
      'Worker',
      'SharedWorker',
      'BroadcastChannel',
      'Notification',
      'navigator.clipboard',
      'navigator.geolocation',
      'performance',
    ];

    for (const api of browserAPIs) {
      // 직접 사용 패턴 확인 (단, typeof window !== 'undefined' 같은 체크는 제외)
      // window, document 등은 단독으로 사용되거나 . 으로 접근하는 경우
      if (api.includes('.')) {
        const pattern = new RegExp(`\\b${api.replace('.', '\\.')}\\b`, 'i');
        if (pattern.test(content)) {
          return true;
        }
      } else {
        // 단독 사용 또는 . 으로 접근하는 경우
        const pattern = new RegExp(`\\b${api}\\s*[\\.\\[]`, 'i');
        if (pattern.test(content)) {
          return true;
        }
      }
    }

    return false;
  }

  // 2.5 상태 관리 라이브러리 사용
  function checkStateManagementLibraries(content) {
    // zustand
    if (content.includes('from "zustand"') || content.includes("from 'zustand'")) {
      const zustandPatterns = ['create', 'useStore', 'persist'];
      for (const pattern of zustandPatterns) {
        if (new RegExp(`\\b${pattern}\\b`).test(content)) {
          return true;
        }
      }
    }

    // react-redux
    if (content.includes('from "react-redux"') || content.includes("from 'react-redux'")) {
      const reduxPatterns = ['Provider', 'useDispatch', 'useSelector'];
      for (const pattern of reduxPatterns) {
        if (new RegExp(`\\b${pattern}\\b`).test(content)) {
          return true;
        }
      }
    }

    // @reduxjs/toolkit
    if (content.includes('from "@reduxjs/toolkit"') || content.includes("from '@reduxjs/toolkit'")) {
      const toolkitPatterns = ['configureStore', 'createSlice'];
      for (const pattern of toolkitPatterns) {
        if (new RegExp(`\\b${pattern}\\b`).test(content)) {
          return true;
        }
      }
    }

    // recoil
    if (content.includes('from "recoil"') || content.includes("from 'recoil'")) {
      const recoilPatterns = ['RecoilRoot', 'atom', 'selector', 'useRecoilState', 'useRecoilValue', 'useSetRecoilState'];
      for (const pattern of recoilPatterns) {
        if (new RegExp(`\\b${pattern}\\b`).test(content)) {
          return true;
        }
      }
    }

    // jotai
    if (content.includes('from "jotai"') || content.includes("from 'jotai'")) {
      const jotaiPatterns = ['atom', 'useAtom'];
      for (const pattern of jotaiPatterns) {
        if (new RegExp(`\\b${pattern}\\b`).test(content)) {
          return true;
        }
      }
    }

    // mobx-react-lite
    if (content.includes('from "mobx-react-lite"') || content.includes("from 'mobx-react-lite'")) {
      if (new RegExp('\\bobserver\\b').test(content)) {
        return true;
      }
    }

    // @tanstack/react-query
    if (content.includes('from "@tanstack/react-query"') || content.includes("from '@tanstack/react-query'")) {
      const queryPatterns = ['useQuery', 'useMutation', 'QueryClientProvider'];
      for (const pattern of queryPatterns) {
        if (new RegExp(`\\b${pattern}\\b`).test(content)) {
          return true;
        }
      }
    }

    // swr
    if (content.includes('from "swr"') || content.includes("from 'swr'")) {
      if (new RegExp('\\buseSWR\\b').test(content)) {
        return true;
      }
    }

    // @apollo/client
    if (content.includes('from "@apollo/client"') || content.includes("from '@apollo/client'")) {
      const apolloPatterns = ['ApolloProvider', 'useQuery', 'useMutation'];
      for (const pattern of apolloPatterns) {
        if (new RegExp(`\\b${pattern}\\b`).test(content)) {
          return true;
        }
      }
    }

    return false;
  }

  // 4. "use client" 추가 (import 문보다 위)
  function addUseClient(content) {
    // 이미 "use client"가 있는지 확인
    if (content.trim().startsWith('"use client";') || content.trim().startsWith("'use client';")) {
      return content;
    }

    // 파일 시작 부분의 공백/주석 처리
    const trimmedContent = content.trimStart();
    const leadingWhitespace = content.slice(0, content.length - trimmedContent.length);

    // "use client"; 추가
    return leadingWhitespace + '"use client";\n' + trimmedContent;
  }

  // 실행
  const tsFiles = await findTsFiles(srcDir, srcAppDir);

  // 각 파일을 검사하여 Client Component 판별 및 "use client" 추가
  for (const filePath of tsFiles) {
    await processFile(filePath);
  }
}

//=========================================================
//Case b: 클라이언트 fetch 패턴 존재 시 "use client" 추가
//=========================================================
async function addUseClientToClientFetchPatterns(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const srcAppDir = path.join(srcDir, 'app');

  if (!fs.existsSync(srcDir)) {
    return;
  }

  // 1. src/ 하위 .tsx, .ts 파일 찾기 (src/app 제외)
  async function findTsFiles(dir, excludeDir) {
    const files = [];
    const excludePath = path.resolve(excludeDir);

    if (!fs.existsSync(dir)) {
      return files;
    }

    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const resolvedPath = path.resolve(fullPath);

      // src/app 디렉터리는 제외
      if (resolvedPath.startsWith(excludePath)) {
        continue;
      }

      if (item.isDirectory()) {
        // node_modules, .next 등 제외
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath, excludeDir);
          files.push(...subFiles);
        }
      } else if (item.isFile() && /\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 2. 클라이언트 실행 API 호출 패턴 확인
  function checkClientFetchPattern(content) {
    // 2.1: JSX 이벤트 핸들러 내부에 fetch/axios 호출
    if (checkEventHandlerFetchPattern(content)) {
      return true;
    }

    // 2.2: useEffect/useLayoutEffect/useInsertionEffect 콜백 내부에 fetch/axios 호출
    if (checkEffectHookFetchPattern(content)) {
      return true;
    }

    // 2.3: 브라우저 전용 API와 같은 함수 스코프에 fetch/axios 호출
    if (checkBrowserAPIWithFetchPattern(content)) {
      return true;
    }

    return false;
  }

  // 2.1: JSX 이벤트 핸들러 내부에 fetch/axios 호출 확인
  function checkEventHandlerFetchPattern(content) {
    // case a의 이벤트 핸들러 목록
    const eventHandlers = [
      'onClick', 'onDoubleClick', 'onMouseDown', 'onMouseUp', 'onMouseEnter',
      'onMouseLeave', 'onMouseMove', 'onMouseOver', 'onMouseOut', 'onContextMenu',
      'onPointerDown', 'onPointerUp', 'onPointerMove', 'onPointerEnter', 'onPointerLeave',
      'onPointerOver', 'onPointerOut', 'onGotPointerCapture', 'onLostPointerCapture',
      'onTouchStart', 'onTouchMove', 'onTouchEnd', 'onTouchCancel',
      'onKeyDown', 'onKeyUp', 'onKeyPress', 'onFocus', 'onBlur',
      'onChange', 'onInput', 'onSubmit', 'onReset', 'onInvalid',
      'onScroll', 'onWheel', 'onDrag', 'onDragStart', 'onDragEnd',
      'onDragEnter', 'onDragLeave', 'onDragOver', 'onDrop',
      'onAnimationStart', 'onAnimationEnd', 'onAnimationIteration', 'onTransitionEnd',
      'onPlay', 'onPause', 'onEnded', 'onTimeUpdate', 'onVolumeChange',
      'onSeeking', 'onSeeked', 'onLoadedData', 'onLoadedMetadata', 'onLoadStart',
      'onCanPlay', 'onCanPlayThrough', 'onWaiting', 'onRateChange', 'onDurationChange',
      'onProgress', 'onStalled', 'onSuspend', 'onEmptied', 'onAbort',
      'onError', 'onCopy', 'onCut', 'onPaste',
      'onCompositionStart', 'onCompositionUpdate', 'onCompositionEnd',
    ];

    for (const handler of eventHandlers) {
      // 이벤트 핸들러 속성 패턴: onClick={...} 또는 onClick={...}
      const handlerPattern = new RegExp(`\\b${handler}\\s*=\\s*\\{([^}]*)\\}`, 'gs');
      let match;

      while ((match = handlerPattern.exec(content)) !== null) {
        const handlerBody = match[1];
        
        // 인라인 함수 확인 (화살표 함수 또는 익명 함수)
        // => 또는 function(...) 패턴
        if (handlerBody.includes('=>') || handlerBody.includes('function(') || handlerBody.includes('async')) {
          // fetch(, axios(, axios. 호출 확인
          if (/\bfetch\s*\(/.test(handlerBody) || 
              /\baxios\s*\(/.test(handlerBody) || 
              /\baxios\./.test(handlerBody)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // 2.2: useEffect/useLayoutEffect/useInsertionEffect 콜백 내부에 fetch/axios 호출 확인
  function checkEffectHookFetchPattern(content) {
    const effectHooks = ['useEffect', 'useLayoutEffect', 'useInsertionEffect'];

    for (const hook of effectHooks) {
      // Hook 호출 패턴: useEffect(() => {...}) 또는 useEffect(function() {...})
      const hookPattern = new RegExp(`\\b${hook}\\s*\\(\\s*([^)]+)\\)`, 'gs');
      let match;

      while ((match = hookPattern.exec(content)) !== null) {
        const callbackArg = match[1];
        
        // 콜백 함수 본문 추출 (화살표 함수 또는 함수 선언)
        // => {...} 또는 function(...) {...} 패턴
        let callbackBody = '';
        
        // 화살표 함수: () => { ... }
        if (callbackArg.includes('=>')) {
          const arrowMatch = callbackArg.match(/=>\s*\{([^}]*)\}/s);
          if (arrowMatch) {
            callbackBody = arrowMatch[1];
          } else {
            // 단일 표현식: () => fetch(...)
            const singleExprMatch = callbackArg.match(/=>\s*(.+)/s);
            if (singleExprMatch) {
              callbackBody = singleExprMatch[1];
            }
          }
        } else {
          // 함수 선언: function() { ... }
          const funcMatch = callbackArg.match(/function\s*\([^)]*\)\s*\{([^}]*)\}/s);
          if (funcMatch) {
            callbackBody = funcMatch[1];
          }
        }

        // fetch(, axios(, axios. 호출 확인
        if (callbackBody && (
          /\bfetch\s*\(/.test(callbackBody) || 
          /\baxios\s*\(/.test(callbackBody) || 
          /\baxios\./.test(callbackBody)
        )) {
          return true;
        }
      }
    }

    return false;
  }

  // 2.3: 브라우저 전용 API와 같은 함수 스코프에 fetch/axios 호출 확인
  function checkBrowserAPIWithFetchPattern(content) {
    // case a의 브라우저 전용 API 목록
    const browserAPIs = [
      'window', 'document', 'navigator', 'location', 'history', 'screen',
      'devicePixelRatio', 'localStorage', 'sessionStorage', 'getComputedStyle',
      'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
      'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'matchMedia',
      'File', 'FileReader', 'Blob', 'URL.createObjectURL',
      'Worker', 'SharedWorker', 'BroadcastChannel', 'Notification',
      'navigator.clipboard', 'navigator.geolocation', 'performance',
    ];

    // 함수 선언/표현식 패턴: function name() {...} 또는 const name = () => {...} 또는 const name = function() {...}
    const functionPatterns = [
      /function\s+\w+\s*\([^)]*\)\s*\{([^}]*)\}/gs,  // function name() {...}
      /const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{([^}]*)\}/gs,  // const name = () => {...}
      /const\s+\w+\s*=\s*function\s*\([^)]*\)\s*\{([^}]*)\}/gs,  // const name = function() {...}
      /const\s+\w+\s*=\s*async\s*\([^)]*\)\s*=>\s*\{([^}]*)\}/gs,  // const name = async () => {...}
      /async\s+function\s+\w+\s*\([^)]*\)\s*\{([^}]*)\}/gs,  // async function name() {...}
    ];

    for (const funcPattern of functionPatterns) {
      let match;
      while ((match = funcPattern.exec(content)) !== null) {
        const functionBody = match[1];
        
        // 함수 본문에 브라우저 전용 API와 fetch/axios가 함께 있는지 확인
        let hasBrowserAPI = false;
        let hasFetch = false;

        for (const api of browserAPIs) {
          if (api.includes('.')) {
            const pattern = new RegExp(`\\b${api.replace(/\./g, '\\.')}\\b`, 'i');
            if (pattern.test(functionBody)) {
              hasBrowserAPI = true;
              break;
            }
          } else {
            const pattern = new RegExp(`\\b${api}\\s*[\\.\\[]`, 'i');
            if (pattern.test(functionBody)) {
              hasBrowserAPI = true;
              break;
            }
          }
        }

        if (hasBrowserAPI) {
          // fetch(, axios(, axios. 호출 확인
          if (/\bfetch\s*\(/.test(functionBody) || 
              /\baxios\s*\(/.test(functionBody) || 
              /\baxios\./.test(functionBody)) {
            hasFetch = true;
          }

          if (hasFetch) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // 3. 예외 조건 확인: 컴포넌트 함수 본문 최상단에 fetch/axios 호출
  function checkServerExecutionPattern(content) {
    // 컴포넌트 함수 본문 최상단 패턴 찾기
    // export default function Component() { ... } 또는 function Component() { ... }
    // 또는 const Component = () => { ... }
    const componentPatterns = [
      /(?:export\s+default\s+)?function\s+\w+\s*\([^)]*\)\s*\{([^}]*)\}/s,
      /const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{([^}]*)\}/s,
      /const\s+\w+\s*=\s*function\s*\([^)]*\)\s*\{([^}]*)\}/s,
    ];

    for (const pattern of componentPatterns) {
      const match = content.match(pattern);
      if (match) {
        const componentBody = match[1];
        
        // 함수 본문 시작 부분 (이벤트 핸들러나 Effect 콜백이 아닌 위치) 확인
        // 첫 500자 정도만 확인 (너무 깊이 들어가지 않도록)
        const topLevelBody = componentBody.substring(0, 500);
        
        // 이벤트 핸들러나 Effect 콜백이 아닌 위치에서 fetch/axios 호출 확인
        // 단순히 최상단에 있는지 확인 (중괄호 깊이 0인 위치)
        const lines = topLevelBody.split('\n');
        let braceDepth = 0;
        
        for (const line of lines) {
          // 중괄호 깊이 계산
          for (const char of line) {
            if (char === '{') braceDepth++;
            if (char === '}') braceDepth--;
          }
          
          // 최상단 레벨(braceDepth === 0 또는 1)에서 fetch/axios 호출 확인
          if (braceDepth <= 1) {
            if (/\bfetch\s*\(/.test(line) || 
                /\baxios\s*\(/.test(line) || 
                /\baxios\./.test(line)) {
              // 이벤트 핸들러나 Effect 콜백이 아닌지 확인
              if (!/on\w+\s*=/.test(line) && 
                  !/useEffect|useLayoutEffect|useInsertionEffect/.test(line)) {
                return true; // 서버 실행 가능성 있음
              }
            }
          }
        }
      }
    }

    return false;
  }

  // 4. 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');

    // "use client"가 이미 존재하는지 확인
    if (content.trim().startsWith('"use client";') || content.trim().startsWith("'use client';")) {
      return; // 이미 존재하면 중복 추가하지 않음
    }

    // 2. 클라이언트 실행 API 호출 패턴 확인
    const hasClientFetchPattern = checkClientFetchPattern(content);

    if (hasClientFetchPattern) {
      // 3. 예외 조건 확인: 서버 실행 가능성 체크
      const hasServerExecutionPattern = checkServerExecutionPattern(content);

      if (!hasServerExecutionPattern) {
        // 5. "use client" 추가
        content = addUseClient(content);
        await fs.writeFile(filePath, content, 'utf-8');
      }
    }
  }

  // 5. "use client" 추가 (import 문보다 위)
  function addUseClient(content) {
    // 이미 "use client"가 있는지 확인
    if (content.trim().startsWith('"use client";') || content.trim().startsWith("'use client';")) {
      return content;
    }

    // 파일 시작 부분의 공백/주석 처리
    const trimmedContent = content.trimStart();
    const leadingWhitespace = content.slice(0, content.length - trimmedContent.length);

    // "use client"; 추가
    return leadingWhitespace + '"use client";\n' + trimmedContent;
  }

  // 실행
  const tsFiles = await findTsFiles(srcDir, srcAppDir);

  // 각 파일을 검사하여 클라이언트 fetch 패턴 확인 및 "use client" 추가
  for (const filePath of tsFiles) {
    await processFile(filePath);
  }
}

module.exports = {
  migrateUseClient,
};
