// src/step1/step1-env.cjs

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const readline = require('readline');

// [중요] 기존의 const CWD = process.cwd(); 는 삭제하거나 주석 처리합니다.
// 함수들이 이제 인자로 경로를 받아서 처리하기 때문입니다.

// ====================================================
// 1. package.json 수정 (cwd 인자 추가)
// ====================================================
async function updatePackageJson(cwd) {
  // [중요] CWD 대신 인자로 받은 cwd 사용
  const pkgPath = path.join(cwd, 'package.json');

  if (!fs.existsSync(pkgPath)) throw new Error('package.json을 찾을 수 없습니다.');
  const pkg = await fs.readJson(pkgPath);

  // Next.js 의존성 추가 (case a: package.json의 의존성에 "next" 추가)
  // 기존 react, react-dom은 변경하지 않음
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['next'] = 'latest';

  // 스크립트 교체 (case b: package.json의 vite scripts를 next scripts로 교체)
  pkg.scripts = pkg.scripts || {};
  // 1.1. "dev": "vite" → "dev": "next dev"
  pkg.scripts['dev'] = 'next dev';
  // 1.2. "build": "tsc -b && vite build" → "build": "next build"
  pkg.scripts['build'] = 'next build';
  // 1.3. "lint": "eslint ." → "lint": "next lint"
  pkg.scripts['lint'] = 'next lint';
  // 1.4. "preview": "vite preview" 삭제
  if (pkg.scripts['preview']) {
    delete pkg.scripts['preview'];
  }
  // 1.5. "start": "next start" 추가
  pkg.scripts['start'] = 'next start';

  await fs.writeJson(pkgPath, pkg, { spaces: 2 });
}

// =================================================================================
// 2. 설정 파일 업데이트 및 정리 (cwd 인자 추가)
// =================================================================================
// 설정 파일 업데이트 및 정리 메인 함수
async function setupConfigFiles(cwd) {
  // Case a: Vite 관련 config 삭제 (tsconfig.node.json, vite-env.d.ts 삭제)
  await removeViteConfigFiles(cwd);

  // Case b: Next 관련 config 생성 (src/next.config.mjs 생성)
  await createNextConfigInSrc(cwd);

  // Case c: .gitignore 업데이트
  await updateGitignoreForNext(cwd);
}

// Case a: Vite 관련 config 삭제 (tsconfig.node.json, vite-env.d.ts 삭제)
// 프로젝트 루트 디렉토리에 있는 tsconfig.node.json과 vite-env.d.ts 파일을 삭제합니다.
// vite-env.d.ts는 프로젝트 루트 또는 src/ 디렉터리에 있을 수 있습니다.
async function removeViteConfigFiles(cwd) {
  // tsconfig.node.json은 프로젝트 루트에만 있음
  const tsconfigNodePath = path.join(cwd, 'tsconfig.node.json');
  if (fs.existsSync(tsconfigNodePath)) {
    await fs.remove(tsconfigNodePath);
  }

  // vite-env.d.ts는 프로젝트 루트 또는 src/ 디렉터리에 있을 수 있음
  const viteEnvPaths = [
    path.join(cwd, 'vite-env.d.ts'),           // 루트
    path.join(cwd, 'src', 'vite-env.d.ts'),   // src/
  ];
  
  for (const viteEnvPath of viteEnvPaths) {
    if (fs.existsSync(viteEnvPath)) {
      await fs.remove(viteEnvPath);
    }
  }
}

// Case b: Next 관련 config 생성 (src/next.config.mjs 생성)
// 프로젝트 루트 기준으로 src/ 디렉터리 하위에 next.config.mjs 파일이 존재하지 않을 경우 생성합니다.
async function createNextConfigInSrc(cwd) {
  const nextConfigPath = path.join(cwd, 'src', 'next.config.mjs');
  // 파일 존재 여부 확인
  if (!fs.existsSync(nextConfigPath)) {
    // src 디렉토리가 없으면 생성
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) {
      await fs.ensureDir(srcDir);
    }
    // next.config.mjs 파일 생성
  const nextConfigContent = `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`;
    await fs.writeFile(nextConfigPath, nextConfigContent);
  }
}

// Case c: .gitignore 업데이트
// .gitignore 파일의 기존 내용을 유지하면서 맨 아래 줄에 .next, .next-env.d.ts, dist를 추가합니다.
async function updateGitignoreForNext(cwd) {
  const gitignorePath = path.join(cwd, '.gitignore');
  const itemsToAdd = ['.next', '.next-env.d.ts', 'dist'];
  
  if (!fs.existsSync(gitignorePath)) {
    // .gitignore 파일이 없으면 새로 생성
    await fs.writeFile(gitignorePath, itemsToAdd.join('\n') + '\n', 'utf-8');
  } else {
    // 기존 내용을 읽어서 유지
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
      // 파일이 비어있거나 null인 경우를 대비
      if (!content || typeof content !== 'string') {
        content = '';
      }
    } catch (error) {
      // 파일 읽기 실패 시 빈 문자열로 처리
      console.warn(chalk.yellow(`⚠️  .gitignore 파일 읽기 실패: ${error.message}`));
      content = '';
    }
    
    // 기존 내용을 백업 (디버깅용)
    const originalContent = content;
    
    // 각 항목이 이미 포함되어 있는지 확인
    const newItems = itemsToAdd.filter((item) => {
      // 정확한 매칭을 위해 줄 단위로 확인
      const lines = content.split('\n');
      return !lines.some((line) => line.trim() === item);
    });
    
    if (newItems.length > 0) {
      // 기존 내용을 유지한 채 파일 맨 아래 줄에 추가
      // 기존 내용이 비어있지 않은 경우에만 줄바꿈 추가
      if (content.trim().length > 0) {
        const prefix = content.endsWith('\n') ? '' : '\n';
        content = content + prefix + newItems.join('\n') + '\n';
      } else {
        // 기존 내용이 비어있으면 새 항목만 추가
        content = newItems.join('\n') + '\n';
      }
      
      // 기존 내용이 실제로 유지되는지 확인
      if (originalContent.trim().length > 0 && !content.includes(originalContent.trim())) {
        console.warn(chalk.yellow('⚠️  .gitignore 기존 내용이 손실될 수 있습니다.'));
      }
      
      // 파일 쓰기
      await fs.writeFile(gitignorePath, content, 'utf-8');
    }
    // newItems.length === 0인 경우 (모든 항목이 이미 존재) 기존 내용 그대로 유지
  }
}

// =================================================================================================
// 3. vite.config.ts 설정 (cwd 인자 추가)
// =================================================================================================

// vite.config.ts 설정 마이그레이션 메인 함수
async function migrateViteConfig(cwd) {
  // Case a: 대상 파일 확인 및 열기
  // 프로젝트 루트에 vite.config.ts 파일이 존재하는지 확인합니다.
  const viteConfigPath = path.join(cwd, 'vite.config.ts');
  
  if (!fs.existsSync(viteConfigPath)) {
    // 파일이 존재하지 않으면 다른 case 수행하지 않음
    return;
  }

  // 파일 읽기
  const viteConfigContent = await fs.readFile(viteConfigPath, 'utf-8');

  // Case b: resolve.alias 존재 여부 확인 및 처리 위치 고정
  // 1. vite.config.ts 파일 안에서 resolve와 alias 항목이 존재하는지 확인한다
  // 2. resolve.alias가 존재하는 경우에도, vite.config.ts의 alias를 Next 설정 파일로 옮기지 않는다
  // 3. alias는 tsconfig.json의 compilerOptions.baseUrl과 compilerOptions.paths에서만 유지된다
  // 4. alias 값이 이미 tsconfig.app.json의 compilerOptions.paths 또는 tsconfig.json에 존재하는 값과 충돌하는지 여부는
  //    "TypeScript 설정(tsconfig.app.json 설정 이관 및 통합)"의 case b "baseUrl, paths 설정 이관"에서 확인한다
  // (이 부분에서는 확인만 하고 실제 처리는 하지 않음)

  // Case c-1: server.proxy가 단순 문자열 형태인 경우
  // server.proxy가 존재하고 각 proxy 항목의 값이 문자열인 경우 rewrites로 마이그레이션
  await migrateServerProxyToRewrites(cwd, viteConfigContent);

  // Case c-2: server.proxy 값이 객체이며 rewrites로 이관 가능한 경우
  // server.proxy가 존재하고 각 proxy 항목의 값이 객체이며, 단순 프록시 + 단순 rewrite인 경우
  const c2Result = await migrateServerProxyObjectToRewrites(cwd, viteConfigContent);
  
  // Case c-3: server.proxy 값이 객체이며 rewrites로 이관 불가한 경우
  // 수동 처리 필요 항목에 대해 사용자에게 안내
  const hasManualProxyItems = c2Result && c2Result.skipped && c2Result.skipped.length > 0;
  let shouldContinueWithProxy = true; // 기본값은 계속 진행
  if (hasManualProxyItems) {
    shouldContinueWithProxy = await printManualProxyMigrationGuide(c2Result.skipped);
  }

  // Case d: server.port 존재 시 package.json dev 스크립트 반영
  await migrateServerPortToPackageJson(cwd, viteConfigContent);

  // Case e: base 존재 시 next.config.mjs basePath 반영
  const basePathConflict = await migrateBaseToNextConfig(cwd, viteConfigContent);

  // Case f: SVG를 React 컴포넌트로 사용하는 경우 처리
  await migrateSvgAsReactComponent(cwd);

  // Case g: Vite define 처리
  await migrateViteDefineInternal(cwd);

  // Case h: vite.config.ts 파일 삭제
  // 위 case 수행 후, Vite 설정이 더 이상 필요하지 않은 상태이므로 삭제
  // basePath 충돌이 발생했거나 proxy 수동 처리가 필요한 경우, 사용자가 계속 진행하기로 한 경우에만 삭제
  // basePath 충돌에서 사용자가 n을 입력한 경우 basePathConflict가 true로 반환되어 여기 도달하지 않음
  if (basePathConflict === false && shouldContinueWithProxy) {
    // 충돌이 없고 proxy도 계속 진행하기로 한 경우 바로 삭제
    if (fs.existsSync(viteConfigPath)) {
      await fs.remove(viteConfigPath);
    }
  } else if (!shouldContinueWithProxy) {
    // proxy 수동 처리에서 사용자가 n을 입력한 경우 삭제하지 않음
    console.log(chalk.yellow('\n⚠️  vite.config.ts 파일이 유지되었습니다. 수동으로 확인 후 삭제해주세요.\n'));
  } else if (basePathConflict === true) {
    // basePath 충돌에서 사용자가 n을 입력한 경우 (이론적으로는 도달하지 않지만 안전을 위해)
    console.log(chalk.yellow('\n⚠️  vite.config.ts 파일이 유지되었습니다. 수동으로 확인 후 삭제해주세요.\n'));
  }
}

// 사용자 확인 함수
function askUserConfirmation(basePathConflict, hasManualProxyItems) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let message = '\n⚠️  작업 중단 사항이 발생했습니다.\n';
    if (basePathConflict) {
      message += '   - basePath 충돌 발생\n';
    }
    if (hasManualProxyItems) {
      message += '   - 수동 처리 필요한 server.proxy 항목 존재\n';
    }
    message += '\n계속 진행하시겠습니까? (y/n): ';

    rl.question(chalk.yellow(message), (answer) => {
      rl.close();
      const shouldContinue = answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes';
      resolve(shouldContinue);
    });
  });
}

// Case c-1: server.proxy를 Next.js rewrites로 마이그레이션
async function migrateServerProxyToRewrites(cwd, viteConfigContent) {
  // server.proxy 존재 여부 확인
  const proxyMatch = viteConfigContent.match(/server\s*:\s*\{[^}]*proxy\s*:\s*\{([^}]+)\}/s);
  if (!proxyMatch) {
    return; // server.proxy가 없으면 종료
  }

  const proxyContent = proxyMatch[1];
  
  // proxy 항목들을 추출 (단순 문자열 형태만 처리)
  // 예: "/api": "http://localhost:8080"
  const proxyPattern = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
  const proxyItems = [];
  let match;

  while ((match = proxyPattern.exec(proxyContent)) !== null) {
    const proxyKey = match[1];
    const targetUrl = match[2];
    
    // 값이 문자열인지 확인 (이미 정규식으로 확인됨)
    proxyItems.push({ proxyKey, targetUrl });
  }

  if (proxyItems.length === 0) {
    return; // 단순 문자열 형태의 proxy가 없으면 종료
  }

  // src/next.config.mjs 파일 열기
  const nextConfigPath = path.join(cwd, 'src', 'next.config.mjs');
  
  if (!fs.existsSync(nextConfigPath)) {
    // 파일이 없으면 생성 (이미 setupConfigFiles에서 생성했지만 안전을 위해)
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) {
      await fs.ensureDir(srcDir);
    }
    const defaultContent = `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`;
    await fs.writeFile(nextConfigPath, defaultContent);
  }

  // next.config.mjs 파일 읽기
  let nextConfigContent = await fs.readFile(nextConfigPath, 'utf-8');

  // rewrites 함수가 이미 존재하는지 확인
  const hasRewrites = /async\s+rewrites\s*\(/i.test(nextConfigContent);

  if (!hasRewrites) {
    // rewrites 함수 추가
    // nextConfig 객체 내부에 rewrites 함수 추가
    const rewritesFunction = `  async rewrites() {
    return [
${proxyItems.map(item => {
  const source = `"${item.proxyKey}/:path*"`;
  const destination = `"${item.targetUrl}${item.proxyKey}/:path*"`;
  return `      {
        source: ${source},
        destination: ${destination},
      }`;
}).join(',\n')}
    ];
  },`;

    // nextConfig 객체 내부에 rewrites 추가
    // const nextConfig = { ... } 형태를 찾아서 내부에 추가
    if (nextConfigContent.includes('const nextConfig = {}')) {
      // 빈 객체인 경우
      nextConfigContent = nextConfigContent.replace(
        'const nextConfig = {}',
        `const nextConfig = {\n${rewritesFunction}\n}`
      );
    } else if (nextConfigContent.match(/const nextConfig\s*=\s*\{/)) {
      // 이미 내용이 있는 경우
      nextConfigContent = nextConfigContent.replace(
        /(const nextConfig\s*=\s*\{)/,
        `$1\n${rewritesFunction}`
      );
    }
  } else {
    // rewrites 함수가 이미 존재하는 경우, 기존 항목에 추가
    // rewrites 함수의 return 배열에 새 항목 추가
    const rewritesArrayMatch = nextConfigContent.match(/return\s*\[\s*([^\]]*)\]/s);
    if (rewritesArrayMatch) {
      const existingRewrites = rewritesArrayMatch[1].trim();
      const newRewrites = proxyItems.map(item => {
        const source = `"${item.proxyKey}/:path*"`;
        const destination = `"${item.targetUrl}${item.proxyKey}/:path*"`;
        return `      {
        source: ${source},
        destination: ${destination},
      }`;
      }).join(',\n');

      const updatedRewrites = existingRewrites 
        ? `${existingRewrites},\n${newRewrites}`
        : newRewrites;

      nextConfigContent = nextConfigContent.replace(
        /return\s*\[\s*[^\]]*\]/s,
        `return [\n${updatedRewrites}\n    ]`
      );
    }
  }

  // 파일 저장
  await fs.writeFile(nextConfigPath, nextConfigContent);
}

// Case c-2: server.proxy 값이 객체이며 rewrites로 이관 가능한 경우
async function migrateServerProxyObjectToRewrites(cwd, viteConfigContent) {
  // 1. vite.config.ts 파일은 이미 열려있음 (migrateViteConfig에서 읽음)
  
  // 2. server.proxy 존재 여부 확인
  const serverProxyMatch = viteConfigContent.match(/server\s*:\s*\{([^}]+proxy\s*:\s*\{[^}]*\}[^}]*)\}/s);
  if (!serverProxyMatch) {
    return { migrated: [], skipped: [] }; // server.proxy가 없으면 종료
  }

  // proxy 객체 전체 추출 (중괄호 매칭으로 정확히 추출)
  const proxyStartMatch = viteConfigContent.match(/proxy\s*:\s*\{/);
  if (!proxyStartMatch) {
    return { migrated: [], skipped: [] };
  }
  
  const proxyStartIndex = proxyStartMatch.index + proxyStartMatch[0].length;
  let braceCount = 1;
  let proxyEndIndex = proxyStartIndex;
  
  for (let i = proxyStartIndex; i < viteConfigContent.length && braceCount > 0; i++) {
    if (viteConfigContent[i] === '{') braceCount++;
    if (viteConfigContent[i] === '}') braceCount--;
    if (braceCount === 0) {
      proxyEndIndex = i;
      break;
    }
  }
  
  if (braceCount !== 0) {
    return { migrated: [], skipped: [] }; // 중괄호 매칭 실패
  }
  
  const proxyContent = viteConfigContent.substring(proxyStartIndex, proxyEndIndex);
  
  // 3. proxy 객체 안의 각 키를 추출
  // 키 패턴: "key" 또는 'key' 또는 key (백틱 포함)
  const proxyKeyPattern = /["'`]([^"'`]+)["'`]\s*:\s*\{/g;
  const proxyItems = [];
  const skippedItems = []; // c-3 케이스 수집
  let keyMatch;

  while ((keyMatch = proxyKeyPattern.exec(proxyContent)) !== null) {
    const proxyKey = keyMatch[1];
    const keyStart = keyMatch.index + keyMatch[0].length;
    
    // 해당 키의 값 객체 찾기 (중괄호 매칭)
    let braceCount = 1;
    let valueEnd = keyStart;
    for (let i = keyStart; i < proxyContent.length && braceCount > 0; i++) {
      if (proxyContent[i] === '{') braceCount++;
      if (proxyContent[i] === '}') braceCount--;
      if (braceCount === 0) {
        valueEnd = i;
        break;
      }
    }
    
    const valueObject = proxyContent.substring(keyStart, valueEnd);
    
    // 4. 값이 객체인지 확인 (이미 중괄호로 감싸져 있음)
    
    // 5. target이 URL 문자열로 존재하는지 확인
    const targetMatch = valueObject.match(/target\s*:\s*["']([^"']+)["']/);
    if (!targetMatch) {
      skippedItems.push({ proxyKey, reason: 'target이 URL 문자열로 존재하지 않음' });
      continue; // target이 없으면 다음 항목으로
    }
    
    const targetUrl = targetMatch[1];
    
    // 6. 금지 옵션 확인
    const forbiddenOptions = [
      'configure', 'bypass', 'ws', 'headers', 'onProxyReq', 'onProxyRes',
      'cookieDomainRewrite', 'cookiePathRewrite', 'autoRewrite', 'secure',
      'agent', 'ca', 'cert', 'key', 'pfx', 'passphrase', 'ciphers'
    ];
    
    const foundForbiddenOptions = forbiddenOptions.filter(option => {
      const regex = new RegExp(`\\b${option}\\s*:`, 'i');
      return regex.test(valueObject);
    });
    
    if (foundForbiddenOptions.length > 0) {
      skippedItems.push({ 
        proxyKey, 
        targetUrl,
        reason: '금지 옵션 존재',
        forbiddenOptions: foundForbiddenOptions
      });
      continue; // 금지 옵션이 있으면 c-3으로 이동 (해당 항목만 skip)
    }
    
    // 7. rewrite 존재 여부 확인
    // rewrite는 화살표 함수나 일반 함수일 수 있으므로 더 넓은 범위로 매칭
    // rewrite: 다음부터 다음 속성(키: 값) 또는 객체 닫는 괄호 전까지 매칭
    // 예: rewrite: (path) => path.replace(/^\/api/, ''),
    const rewriteMatch = valueObject.match(/rewrite\s*:\s*([^,}]+(?:\([^)]*\)[^,}]*)*?)(?:,\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*:|$)/);
    
    let rewriteType = null; // null: 없음, 'remove': 접두사 제거, 'replace': 접두사 치환
    let newPrefix = null;
    
    if (rewriteMatch) {
      const rewriteContent = rewriteMatch[1].trim();
      
      // 8. rewrite가 "접두사 제거" 또는 "접두사 치환"으로만 설명 가능한지 확인
      // replace() 호출이 있는지 확인
      // 패턴: .replace(/정규식/, '문자열') 또는 .replace(/정규식/, "문자열")
      // 정규식 리터럴은 /.../ 형태인데, 이스케이프된 슬래시 \/를 포함할 수 있음
      // 예: path.replace(/^\/api/, '') 또는 path.replace(/^\/api/, "")
      // 정규식 리터럴 매칭: /로 시작해서 이스케이프되지 않은 /로 끝남
      // 더 간단하게: /로 시작해서 /로 끝나는 부분을 찾되, 중간에 이스케이프된 \/는 허용
      const replacePattern1 = rewriteContent.match(/\.replace\s*\(\s*\/(?:[^\/\\]|\\.)+\/,\s*["']([^"']*)["']\s*\)/);
      // new RegExp() 형태도 처리
      const replacePattern2 = rewriteContent.match(/\.replace\s*\(\s*new\s+RegExp\([^)]+\),\s*["']([^"']*)["']\s*\)/);
      // 문자열 패턴도 처리 (예: .replace("...", "..."))
      const replacePattern3 = rewriteContent.match(/\.replace\s*\(\s*["'][^"']*["'],\s*["']([^"']*)["']\s*\)/);
      
      const replaceMatchFinal = replacePattern1 || replacePattern2 || replacePattern3;
      
      if (replaceMatchFinal) {
        const replaceSecondArg = replaceMatchFinal[1];
        
        if (replaceSecondArg === '') {
          // 접두사 제거
          rewriteType = 'remove';
        } else {
          // 접두사 치환
          rewriteType = 'replace';
          newPrefix = replaceSecondArg;
        }
      } else {
        // replace()가 없거나 복잡한 경우 → c-3으로 이동 (skip)
        skippedItems.push({ 
          proxyKey, 
          targetUrl,
          reason: 'rewrite가 단순 접두사 제거/치환으로 설명 불가능 (복잡한 변환 로직 포함)'
        });
        continue;
      }
    }
    
    // 이관 가능한 항목으로 추가
    proxyItems.push({
      proxyKey,
      targetUrl,
      rewriteType,
      newPrefix
    });
  }
  
  if (proxyItems.length === 0 && skippedItems.length === 0) {
    return { migrated: [], skipped: [] }; // 이관 가능한 항목이 없으면 종료
  }
  
  // 9. src/next.config.mjs 파일 열기
  const nextConfigPath = path.join(cwd, 'src', 'next.config.mjs');
  
  if (!fs.existsSync(nextConfigPath)) {
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) {
      await fs.ensureDir(srcDir);
    }
    const defaultContent = `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`;
    await fs.writeFile(nextConfigPath, defaultContent);
  }
  
  // 10-17. next.config.mjs에 rewrites 추가
  let nextConfigContent = await fs.readFile(nextConfigPath, 'utf-8');
  
  // rewrites 함수가 이미 존재하는지 확인
  const hasRewrites = /async\s+rewrites\s*\(/i.test(nextConfigContent);
  
  // rewrites 객체 생성
  const rewritesObjects = proxyItems.map(item => {
    const source = `"${item.proxyKey}/:path*"`;
    let destination;
    
    if (item.rewriteType === null) {
      // c-2-1: rewrite 없음 (prefix 유지)
      destination = `"${item.targetUrl}${item.proxyKey}/:path*"`;
    } else if (item.rewriteType === 'remove') {
      // c-2-2: 접두사 제거
      destination = `"${item.targetUrl}/:path*"`;
    } else if (item.rewriteType === 'replace') {
      // c-2-3: 접두사 치환
      destination = `"${item.targetUrl}${item.newPrefix}/:path*"`;
    }
    
    return `      {
        source: ${source},
        destination: ${destination},
      }`;
  });
  
  if (!hasRewrites) {
    // rewrites 함수 추가
    const rewritesFunction = `  async rewrites() {
    return [
${rewritesObjects.join(',\n')}
    ];
  },`;
    
    if (nextConfigContent.includes('const nextConfig = {}')) {
      nextConfigContent = nextConfigContent.replace(
        'const nextConfig = {}',
        `const nextConfig = {\n${rewritesFunction}\n}`
      );
    } else if (nextConfigContent.match(/const nextConfig\s*=\s*\{/)) {
      nextConfigContent = nextConfigContent.replace(
        /(const nextConfig\s*=\s*\{)/,
        `$1\n${rewritesFunction}`
      );
    }
  } else {
    // rewrites 함수가 이미 존재하는 경우, 기존 항목에 추가
    const rewritesArrayMatch = nextConfigContent.match(/return\s*\[\s*([^\]]*)\]/s);
    if (rewritesArrayMatch) {
      const existingRewrites = rewritesArrayMatch[1].trim();
      const newRewrites = rewritesObjects.join(',\n');
      
      const updatedRewrites = existingRewrites 
        ? `${existingRewrites},\n${newRewrites}`
        : newRewrites;
      
      nextConfigContent = nextConfigContent.replace(
        /return\s*\[\s*[^\]]*\]/s,
        `return [\n${updatedRewrites}\n    ]`
      );
    }
  }
  
  // 파일 저장
  await fs.writeFile(nextConfigPath, nextConfigContent);
  
  return { migrated: proxyItems, skipped: skippedItems };
}

// Case c-3: server.proxy 값이 객체이며 rewrites로 이관 불가한 경우 - 사용자 안내
async function printManualProxyMigrationGuide(skippedItems) {
  console.log('\n' + chalk.yellow.bold('⚠️  수동 처리 필요: server.proxy 설정'));
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  
  console.log(chalk.yellow('\n다음 proxy 설정은 자동으로 Next.js rewrites로 이관할 수 없습니다:'));
  console.log('');
  
  skippedItems.forEach((item, index) => {
    console.log(chalk.yellow(`  ${index + 1}. ${chalk.bold(item.proxyKey)}`));
    if (item.targetUrl) {
      console.log(chalk.gray(`     → Target: ${item.targetUrl}`));
    }
    console.log(chalk.gray(`     → 사유: ${item.reason}`));
    if (item.forbiddenOptions && item.forbiddenOptions.length > 0) {
      console.log(chalk.gray(`     → 발견된 옵션: ${item.forbiddenOptions.join(', ')}`));
    }
    console.log('');
  });
  
  console.log(chalk.cyan.bold('\n📋 수동 처리 방법:'));
  console.log('');
  console.log(chalk.cyan('방법 1: Next.js API Routes 사용 (권장)'));
  console.log(chalk.gray('  Next.js API Routes를 사용하여 서버 사이드에서 외부 API를 호출합니다.'));
  console.log('');
  console.log(chalk.gray('  예시:'));
  console.log(chalk.white('  // src/app/api/proxy/[...path]/route.ts'));
  console.log(chalk.white('  export async function GET(request: Request) {'));
  console.log(chalk.white('    const { path } = await request.json();'));
  console.log(chalk.white('    const targetUrl = "http://localhost:8080";'));
  console.log(chalk.white('    const response = await fetch(`${targetUrl}${path}`);'));
  console.log(chalk.white('    return new Response(response.body, {'));
  console.log(chalk.white('      status: response.status,'));
  console.log(chalk.white('      headers: response.headers,'));
  console.log(chalk.white('    });'));
  console.log(chalk.white('  }'));
  console.log('');
  console.log(chalk.cyan('방법 2: 별도의 프록시 서버 구성'));
  console.log(chalk.gray('  http-proxy-middleware나 다른 프록시 서버를 별도로 구성합니다.'));
  console.log('');
  console.log(chalk.gray('  예시:'));
  console.log(chalk.white('  // 별도 프록시 서버 (예: express + http-proxy-middleware)'));
  console.log(chalk.white('  const express = require("express");'));
  console.log(chalk.white('  const { createProxyMiddleware } = require("http-proxy-middleware");'));
  console.log(chalk.white('  const app = express();'));
  console.log(chalk.white('  app.use("/api", createProxyMiddleware({'));
  console.log(chalk.white('    target: "http://localhost:8080",'));
  console.log(chalk.white('    changeOrigin: true,'));
  console.log(chalk.white('    // 필요한 추가 옵션 설정'));
  console.log(chalk.white('  }));'));
  console.log('');
  console.log(chalk.cyan('방법 3: 클라이언트 사이드에서 직접 호출'));
  console.log(chalk.gray('  복잡한 프록시 설정이 필요한 경우, 클라이언트에서 직접 외부 API를 호출합니다.'));
  console.log(chalk.gray('  (CORS 설정이 필요할 수 있습니다)'));
  console.log('');
  console.log(chalk.yellow('💡 참고:'));
  console.log(chalk.gray('  - WebSocket(ws) 지원이 필요한 경우: Next.js API Routes에서 WebSocket을 직접 처리하거나'));
  console.log(chalk.gray('    별도의 WebSocket 서버를 구성해야 합니다.'));
  console.log(chalk.gray('  - 헤더 조작이 필요한 경우: Next.js API Routes의 request/response 객체를 사용하여'));
  console.log(chalk.gray('    헤더를 수정할 수 있습니다.'));
  console.log(chalk.gray('  - 쿠키 도메인/경로 재작성이 필요한 경우: Next.js API Routes에서 쿠키를 직접 처리해야 합니다.'));
  console.log('');
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  
  // 사용자 확인
  const shouldContinue = await askUserConfirmation(false, true);
  return shouldContinue;
}

// Case d: server.port 존재 시 package.json dev 스크립트 반영
async function migrateServerPortToPackageJson(cwd, viteConfigContent) {
  // 1. server.port 항목이 vite.config.ts에 존재하는지 확인
  const serverPortMatch = viteConfigContent.match(/server\s*:\s*\{[^}]*port\s*:\s*(\d+)/);
  if (!serverPortMatch) {
    return; // server.port가 없으면 종료
  }

  // 2. server.port 값 확인
  const port = serverPortMatch[1];

  // 3. 프로젝트 루트의 package.json 파일 열기
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return; // package.json이 없으면 종료
  }

  const packageJson = await fs.readJson(packageJsonPath);

  // 4. scripts 블록에 dev 항목이 존재하는지 확인
  packageJson.scripts = packageJson.scripts || {};

  // 5. dev 항목이 존재하면 값을 변경, 없으면 추가
  packageJson.scripts.dev = `next dev -p ${port}`;

  // package.json 저장
  await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
}

// Case e: base 존재 시 next.config.mjs basePath 반영
// 반환값: true = 충돌 발생, false = 정상 처리 또는 base 없음
async function migrateBaseToNextConfig(cwd, viteConfigContent) {
  // 1. base 항목이 vite.config.ts에 존재하는지 확인
  const baseMatch = viteConfigContent.match(/base\s*:\s*["']([^"']+)["']/);
  if (!baseMatch) {
    return false; // base가 없으면 false 반환 (충돌 없음)
  }

  // 2. base 값 확인 (마지막 슬래시 제거)
  let baseValue = baseMatch[1];
  if (baseValue.endsWith('/')) {
    baseValue = baseValue.slice(0, -1);
  }

  // 3. 프로젝트 루트 기준으로 src/next.config.mjs 파일 열기
  const nextConfigPath = path.join(cwd, 'src', 'next.config.mjs');
  if (!fs.existsSync(nextConfigPath)) {
    // 파일이 없으면 생성
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) {
      await fs.ensureDir(srcDir);
    }
    const defaultContent = `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`;
    await fs.writeFile(nextConfigPath, defaultContent);
  }

  // 4. nextConfig 객체에 basePath 항목이 존재하는지 확인
  let nextConfigContent = await fs.readFile(nextConfigPath, 'utf-8');

  // basePath 존재 여부 확인
  const basePathMatch = nextConfigContent.match(/basePath\s*:\s*["']([^"']+)["']/);
  
  if (basePathMatch) {
    // 7. basePath가 이미 존재하고 값이 다른 경우 충돌 처리
    const existingBasePath = basePathMatch[1];
    if (existingBasePath !== baseValue) {
      console.warn(chalk.yellow('\n⚠️  basePath 충돌 발생'));
      console.warn(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.warn(chalk.yellow(`\nnext.config.mjs에 이미 basePath="${existingBasePath}"가 존재합니다.`));
      console.warn(chalk.yellow(`vite.config.ts의 base="${baseMatch[1]}"와 값이 다릅니다.`));
      console.warn(chalk.cyan('\n📋 수동 처리 방법:'));
      console.warn(chalk.gray('\n1. 두 값 중 어느 것이 올바른지 확인하세요.'));
      console.warn(chalk.gray('   - vite.config.ts의 base: Vite 프로젝트에서 사용하던 base 경로'));
      console.warn(chalk.gray('   - next.config.mjs의 basePath: Next.js 프로젝트에서 이미 설정된 경로'));
      console.warn(chalk.gray('\n2. 올바른 값을 결정한 후:'));
      console.warn(chalk.gray('   - src/next.config.mjs 파일을 열어서 basePath 값을 수정하세요.'));
      console.warn(chalk.gray('   - 예시: basePath: "/your-correct-path"'));
      console.warn(chalk.gray('\n3. 만약 vite.config.ts의 base 값을 사용하려면:'));
      console.warn(chalk.white(`   basePath: "${baseValue}"`));
      console.warn(chalk.gray('\n4. 만약 기존 next.config.mjs의 basePath 값을 유지하려면:'));
      console.warn(chalk.white(`   basePath: "${existingBasePath}" (현재 값 유지)`));
      console.warn(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
      
      // 사용자 확인
      const shouldContinue = await askUserConfirmation(true, false);
      if (!shouldContinue) {
        return true; // 사용자가 n을 입력한 경우 충돌로 반환 (작업 중단)
      }
      // 사용자가 y를 입력한 경우 계속 진행
      return false; // 충돌이 있지만 사용자가 계속 진행하기로 함
    }
    // 값이 같으면 유지 (아무것도 하지 않음)
    return false; // 충돌 없음
  }

  // 5. basePath가 존재하지 않으면 추가
  // nextConfig 객체에 basePath 추가
  if (nextConfigContent.includes('const nextConfig = {}')) {
    // 빈 객체인 경우
    nextConfigContent = nextConfigContent.replace(
      'const nextConfig = {}',
      `const nextConfig = {\n  basePath: "${baseValue}",\n}`
    );
  } else if (nextConfigContent.match(/const nextConfig\s*=\s*\{/)) {
    // 이미 내용이 있는 경우
    nextConfigContent = nextConfigContent.replace(
      /(const nextConfig\s*=\s*\{)/,
      `$1\n  basePath: "${baseValue}",`
    );
  }

  // 파일 저장
  await fs.writeFile(nextConfigPath, nextConfigContent);
  return false; // 정상 처리 완료 (충돌 없음)
}

// Case f: SVG를 React 컴포넌트로 사용하는 경우 처리
async function migrateSvgAsReactComponent(cwd) {
  // 1. SVG를 React 컴포넌트로 사용하는 패턴 감지
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) {
    return; // src 디렉토리가 없으면 종료
  }

  // 프로젝트 내 모든 .ts, .tsx, .js, .jsx 파일에서 SVG 사용 패턴 찾기
  const svgPatterns = {
    hasReactQuery: false, // import X from ".../xxx.svg?react"
    hasReactComponent: false, // import { ReactComponent as X } from ".../xxx.svg"
    hasSvgAsComponent: false // import X from ".../xxx.svg" 이후 <X /> 형태
  };

  // 파일 탐색 함수
  async function findSvgPatterns(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // node_modules, .next 등 제외
        if (!['node_modules', '.next', '.git'].includes(entry.name)) {
          await findSvgPatterns(fullPath);
        }
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        
        // 패턴 1: import X from ".../xxx.svg?react"
        if (/import\s+\w+\s+from\s+["'][^"']+\.svg\?react["']/.test(content)) {
          svgPatterns.hasReactQuery = true;
        }
        
        // 패턴 2: import { ReactComponent as X } from ".../xxx.svg"
        if (/import\s*\{\s*ReactComponent\s+as\s+\w+\s*\}\s+from\s+["'][^"']+\.svg["']/.test(content)) {
          svgPatterns.hasReactComponent = true;
        }
        
        // 패턴 3: import X from ".../xxx.svg" 이후 <X /> 형태
        const svgImportMatch = content.match(/import\s+(\w+)\s+from\s+["'][^"']+\.svg["']/);
        if (svgImportMatch) {
          const importName = svgImportMatch[1];
          // JSX에서 <ImportName /> 형태로 사용하는지 확인
          const jsxPattern = new RegExp(`<${importName}\\s*/?>`);
          if (jsxPattern.test(content)) {
            svgPatterns.hasSvgAsComponent = true;
          }
        }
      }
    }
  }

  await findSvgPatterns(srcDir);

  // 1.1, 1.2: SVG 컴포넌트 사용 여부 확인
  const usesSvgComponent = svgPatterns.hasReactQuery || 
                          svgPatterns.hasReactComponent || 
                          svgPatterns.hasSvgAsComponent;

  if (!usesSvgComponent) {
    return; // SVG 컴포넌트를 사용하지 않으면 종료 (case h로 넘어감)
  }

  // 2. SVG 사용 방식 분류
  // 2.1, 2.2: ?react 쿼리 사용 여부 확인
  const usesReactQuery = svgPatterns.hasReactQuery;

  // 3. A 또는 4. B 수행
  if (usesReactQuery) {
    // Case A: ?react 쿼리를 사용하는 경우
    await configureSvgForReactQuery(cwd);
  } else {
    // Case B: ?react 없이 SVG를 컴포넌트로 사용하는 경우
    await configureSvgWithoutReactQuery(cwd);
  }
}

// Case A: ?react 쿼리를 사용하는 경우
async function configureSvgForReactQuery(cwd) {
  // 3.1. 의존성 추가
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }

  const packageJson = await fs.readJson(packageJsonPath);
  packageJson.devDependencies = packageJson.devDependencies || {};

  // 3.1.1, 3.1.2: @svgr/webpack 추가
  if (!packageJson.devDependencies['@svgr/webpack']) {
    packageJson.devDependencies['@svgr/webpack'] = '^8.0.0';
    await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
  }

  // 3.2. webpack 설정 추가
  const nextConfigPath = path.join(cwd, 'src', 'next.config.mjs');
  if (!fs.existsSync(nextConfigPath)) {
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) {
      await fs.ensureDir(srcDir);
    }
    const defaultContent = `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`;
    await fs.writeFile(nextConfigPath, defaultContent);
  }

  let nextConfigContent = await fs.readFile(nextConfigPath, 'utf-8');

  // 3.2.1, 3.2.2: webpack 함수 존재 여부 확인 및 추가
  const hasWebpack = /webpack\s*\(/i.test(nextConfigContent);
  
  if (!hasWebpack) {
    // webpack 함수 추가
    if (nextConfigContent.includes('const nextConfig = {}')) {
      nextConfigContent = nextConfigContent.replace(
        'const nextConfig = {}',
        `const nextConfig = {
  webpack(config) {
    config.module.rules.push({
      test: /\\.svg$/i,
      resourceQuery: /react/,
      issuer: /\\.[tj]sx?$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
}`
      );
    } else if (nextConfigContent.match(/const nextConfig\s*=\s*\{/)) {
      nextConfigContent = nextConfigContent.replace(
        /(const nextConfig\s*=\s*\{)/,
        `$1
  webpack(config) {
    config.module.rules.push({
      test: /\\.svg$/i,
      resourceQuery: /react/,
      issuer: /\\.[tj]sx?$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },`
      );
    }
  } else {
    // webpack 함수가 이미 존재하는 경우, 규칙만 추가
    // 3.2.3: webpack 함수 내부에 규칙 추가
    const svgRulePattern = /test:\s*\/\\.svg\$/i;
    if (!svgRulePattern.test(nextConfigContent)) {
      // config.module.rules.push 부분 찾기
      const rulesPushMatch = nextConfigContent.match(/(config\.module\.rules\.push\s*\([^)]*\))/s);
      if (rulesPushMatch) {
        // 기존 push에 추가
        const newRule = `    config.module.rules.push({
      test: /\\.svg$/i,
      resourceQuery: /react/,
      issuer: /\\.[tj]sx?$/,
      use: ["@svgr/webpack"],
    });`;
        nextConfigContent = nextConfigContent.replace(
          /(webpack\s*\([^)]*config[^)]*\)\s*\{)/,
          `$1\n${newRule}`
        );
      } else {
        // push가 없으면 추가
        nextConfigContent = nextConfigContent.replace(
          /(webpack\s*\([^)]*config[^)]*\)\s*\{)/,
          `$1\n    config.module.rules.push({
      test: /\\.svg$/i,
      resourceQuery: /react/,
      issuer: /\\.[tj]sx?$/,
      use: ["@svgr/webpack"],
    });`
        );
      }
    }
  }

  await fs.writeFile(nextConfigPath, nextConfigContent);
}

// Case B: ?react 없이 SVG를 컴포넌트로 사용하는 경우
async function configureSvgWithoutReactQuery(cwd) {
  // 4.1. 의존성 추가
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }

  const packageJson = await fs.readJson(packageJsonPath);
  packageJson.devDependencies = packageJson.devDependencies || {};

  // 4.1.1, 4.1.2: @svgr/webpack 추가
  if (!packageJson.devDependencies['@svgr/webpack']) {
    packageJson.devDependencies['@svgr/webpack'] = '^8.0.0';
    await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
  }

  // 4.2. webpack 설정 추가
  const nextConfigPath = path.join(cwd, 'src', 'next.config.mjs');
  if (!fs.existsSync(nextConfigPath)) {
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) {
      await fs.ensureDir(srcDir);
    }
    const defaultContent = `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`;
    await fs.writeFile(nextConfigPath, defaultContent);
  }

  let nextConfigContent = await fs.readFile(nextConfigPath, 'utf-8');

  // 4.2.1, 4.2.2: webpack 함수 존재 여부 확인 및 추가
  const hasWebpack = /webpack\s*\(/i.test(nextConfigContent);
  
  if (!hasWebpack) {
    // webpack 함수 추가
    if (nextConfigContent.includes('const nextConfig = {}')) {
      nextConfigContent = nextConfigContent.replace(
        'const nextConfig = {}',
        `const nextConfig = {
  webpack(config) {
    config.module.rules.push({
      test: /\\.svg$/i,
      issuer: /\\.[tj]sx?$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
}`
      );
    } else if (nextConfigContent.match(/const nextConfig\s*=\s*\{/)) {
      nextConfigContent = nextConfigContent.replace(
        /(const nextConfig\s*=\s*\{)/,
        `$1
  webpack(config) {
    config.module.rules.push({
      test: /\\.svg$/i,
      issuer: /\\.[tj]sx?$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },`
      );
    }
  } else {
    // webpack 함수가 이미 존재하는 경우, 규칙만 추가
    // 4.2.3: webpack 함수 내부에 규칙 추가
    const svgRulePattern = /test:\s*\/\\.svg\$/i;
    if (!svgRulePattern.test(nextConfigContent)) {
      // config.module.rules.push 부분 찾기
      const rulesPushMatch = nextConfigContent.match(/(config\.module\.rules\.push\s*\([^)]*\))/s);
      if (rulesPushMatch) {
        // 기존 push에 추가
        const newRule = `    config.module.rules.push({
      test: /\\.svg$/i,
      issuer: /\\.[tj]sx?$/,
      use: ["@svgr/webpack"],
    });`;
        nextConfigContent = nextConfigContent.replace(
          /(webpack\s*\([^)]*config[^)]*\)\s*\{)/,
          `$1\n${newRule}`
        );
      } else {
        // push가 없으면 추가
        nextConfigContent = nextConfigContent.replace(
          /(webpack\s*\([^)]*config[^)]*\)\s*\{)/,
          `$1\n    config.module.rules.push({
      test: /\\.svg$/i,
      issuer: /\\.[tj]sx?$/,
      use: ["@svgr/webpack"],
    });`
        );
      }
    }
  }

  await fs.writeFile(nextConfigPath, nextConfigContent);
}

// Case g: Vite define 처리
// migrateViteConfig 내부에서 호출되는 내부 함수
async function migrateViteDefineInternal(cwd) {
  // vite.config.ts 파일이 존재하는지 확인 (migrateViteConfig에서 이미 확인했지만 안전을 위해)
  const viteConfigPath = path.join(cwd, 'vite.config.ts');
  if (!fs.existsSync(viteConfigPath)) {
    return;
  }
  
  await migrateViteDefineLogic(cwd);
}

// 외부에서 호출 가능한 함수 (하위 호환성 유지)
async function migrateViteDefine(cwd) {
  // vite.config.ts 파일 읽기
  const viteConfigPath = path.join(cwd, 'vite.config.ts');
  if (!fs.existsSync(viteConfigPath)) {
    // 파일이 없으면 본 모듈 수행하지 않고 다음 모듈로 넘어감
    return;
  }
  
  await migrateViteDefineLogic(cwd);
}

// 실제 로직 함수
async function migrateViteDefineLogic(cwd) {
  // vite.config.ts 파일 읽기
  const viteConfigPath = path.join(cwd, 'vite.config.ts');
  const viteConfigContent = await fs.readFile(viteConfigPath, 'utf-8');
  // Case a: vite.config.ts에 define이 존재하지 않음
  // define 객체 추출 시도 (중괄호 매칭으로 정확히 추출)
  const defineStartMatch = viteConfigContent.match(/define\s*:\s*\{/);
  if (!defineStartMatch) {
    // define이 없으면 모든 파일에서 import.meta.env.VITE_* 패턴을 찾아서 변환
    await migrateImportMetaEnvInAllFiles(cwd);
    return;
  }

  const defineStartIndex = defineStartMatch.index + defineStartMatch[0].length;
  let braceCount = 1;
  let defineEndIndex = defineStartIndex;

  for (let i = defineStartIndex; i < viteConfigContent.length && braceCount > 0; i++) {
    if (viteConfigContent[i] === '{') braceCount++;
    if (viteConfigContent[i] === '}') braceCount--;
    if (braceCount === 0) {
      defineEndIndex = i;
      break;
    }
  }

  if (braceCount !== 0) {
    // 중괄호 매칭 실패
    return;
  }

  const defineContent = viteConfigContent.substring(defineStartIndex, defineEndIndex);

  // Case b: define.global = "window" 만 존재 (또는 포함)
  const globalWindowMatch = defineContent.match(/global\s*:\s*["']window["']/);
  if (globalWindowMatch) {
    console.log(chalk.yellow('\n⚠️  define에 global: "window" 설정이 발견되었습니다.'));
    console.log(chalk.yellow('   Next 환경에서 자동 치환 시 서버 런타임 오류가 발생할 수 있으므로 수동 확인이 필요합니다.'));
    // 자동 변환하지 않고 경고만 출력
  }

  // Case c: define에 빌드 타임 상수 키가 존재 (___XXX___ 형태)
  await migrateBuildTimeConstants(cwd, defineContent, viteConfigContent);

  // Case d: define이 process.env.*를 하드 코딩 치환하는 형태
  await migrateProcessEnvInDefine(cwd, defineContent);

  // Case e: define 값이 복잡한 표현식/객체/함수/참조 포함
  await handleComplexDefineExpressions(cwd, defineContent);

  // Case f: define에 import.meta.env.* 직접 치환이 들어있는 경우
  await migrateImportMetaEnvInDefine(cwd, defineContent);
}

// Case c: 빌드 타임 상수 마이그레이션
async function migrateBuildTimeConstants(cwd, defineContent, viteConfigContent) {
  // 1. define 객체의 각 키를 순회
  const constantKeys = [];
  const keyValuePattern = /["']?([^"':\s]+)["']?\s*:\s*([^,}]+)/g;
  let match;

  while ((match = keyValuePattern.exec(defineContent)) !== null) {
    const key = match[1].trim();
    const value = match[2].trim();

    // 2. 키가 문자열 리터럴이 아니고 정규식에 매칭되면 상수 키로 분류
    const constantKeyPattern = /^_[A-Z0-9_]+_$/;
    if (constantKeyPattern.test(key)) {
      // 3. 값 표현식이 다음 중 하나인지 확인
      // JSON.stringify("...") 형태의 문자열 상수
      // JSON.stringify(숫자 리터럴) 형태
      // "..." 문자열 리터럴 자체
      // 숫자 리터럴 자체
      const isStringifyString = /JSON\.stringify\s*\(\s*["']([^"']+)["']\s*\)/.test(value);
      const isStringifyNumber = /JSON\.stringify\s*\(\s*(\d+(?:\.\d+)?)\s*\)/.test(value);
      const isStringLiteral = /^["']([^"']+)["']$/.test(value);
      const isNumberLiteral = /^\d+(?:\.\d+)?$/.test(value);

      if (isStringifyString || isStringifyNumber || isStringLiteral || isNumberLiteral) {
        let constantValue;
        if (isStringifyString) {
          const strMatch = value.match(/JSON\.stringify\s*\(\s*["']([^"']+)["']\s*\)/);
          constantValue = { type: 'string', value: strMatch[1] };
        } else if (isStringifyNumber) {
          const numMatch = value.match(/JSON\.stringify\s*\(\s*(\d+(?:\.\d+)?)\s*\)/);
          constantValue = { type: 'number', value: parseFloat(numMatch[1]) };
        } else if (isStringLiteral) {
          const strMatch = value.match(/^["']([^"']+)["']$/);
          constantValue = { type: 'string', value: strMatch[1] };
        } else if (isNumberLiteral) {
          constantValue = { type: 'number', value: parseFloat(value) };
        }

        constantKeys.push({
          originalKey: key,
          constantName: key.replace(/^_|_$/g, ''), // 양쪽 _ 제거
          value: constantValue
        });
      }
    }
  }

  if (constantKeys.length === 0) {
    return; // 빌드 타임 상수가 없으면 종료
  }

  // 4. src/constants/build.ts 파일 생성
  const constantsDir = path.join(cwd, 'src', 'constants');
  const buildTsPath = path.join(constantsDir, 'build.ts');
  await fs.ensureDir(constantsDir);

  // 5. 각 상수 키에 대해 export 상수 생성
  const constantsContent = constantKeys.map(constant => {
    const valueStr = constant.value.type === 'string'
      ? `"${constant.value.value}"`
      : constant.value.value.toString();
    return `export const ${constant.constantName} = ${valueStr};`;
  }).join('\n');

  await fs.writeFile(buildTsPath, constantsContent + '\n', 'utf-8');

  // 6. 프로젝트 전체 .ts, .tsx에서 해당 define 키 식별자 사용 검색
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // tsconfig.json에서 paths 확인 (alias 경로 확인용)
  const tsConfigPath = path.join(cwd, 'tsconfig.json');
  let hasPathAlias = false;
  let aliasPrefix = '@/';
  if (fs.existsSync(tsConfigPath)) {
    try {
      const tsConfig = await readJsonSafe(tsConfigPath);
      if (tsConfig?.compilerOptions?.paths) {
        const paths = tsConfig.compilerOptions.paths;
        const aliasKey = Object.keys(paths).find(key => key.startsWith('@/'));
        if (aliasKey) {
          hasPathAlias = true;
          aliasPrefix = aliasKey;
        }
      }
    } catch (e) {
      // 무시
    }
  }

  // 7. 파일에서 사용하는 define 키 치환
  async function findTsFiles(dir) {
    const files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', '.next', '.git'].includes(entry.name)) {
        files.push(...await findTsFiles(fullPath));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const tsFiles = await findTsFiles(srcDir);
  const importPath = hasPathAlias ? `${aliasPrefix}constants/build` : '../constants/build';

  for (const filePath of tsFiles) {
    let content = await fs.readFile(filePath, 'utf-8');
    let modified = false;
    const importsToAdd = new Set();

    for (const constant of constantKeys) {
      // _APP_VERSION_ 같은 식별자를 APP_VERSION으로 치환
      const regex = new RegExp(`\\b${constant.originalKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      if (regex.test(content)) {
        content = content.replace(regex, constant.constantName);
        importsToAdd.add(constant.constantName);
        modified = true;
      }
    }

    if (modified) {
      // 파일 상단에 import 추가
      const importStatement = `import { ${Array.from(importsToAdd).join(', ')} } from "${importPath}";\n`;
      
      // 이미 import가 있는지 확인
      if (!content.includes(`from "${importPath}"`) && !content.includes(`from '${importPath}'`)) {
        // 첫 번째 import 문 다음에 추가
        const firstImportMatch = content.match(/^import\s+.*?from\s+["'][^"']+["'];?\s*\n/m);
        if (firstImportMatch) {
          content = content.replace(
            /^import\s+.*?from\s+["'][^"']+["'];?\s*\n/m,
            match => match + importStatement
          );
        } else {
          // import가 없으면 파일 맨 위에 추가
          content = importStatement + content;
        }
      }

      await fs.writeFile(filePath, content, 'utf-8');
    }
  }
}

// Case d: process.env.* 하드 코딩 치환 처리
async function migrateProcessEnvInDefine(cwd, defineContent) {
  // 1. define 객체의 키 중 문자열 리터럴로 작성된 키 찾기
  const processEnvPattern = /["'](process\.env\.[A-Z_][A-Z0-9_]*)["']\s*:\s*([^,}]+)/g;
  const matches = [];
  let match;

  while ((match = processEnvPattern.exec(defineContent)) !== null) {
    const key = match[1]; // process.env.API_URL
    const value = match[2].trim();

    // 2. 키가 정확히 process.env. 접두사로 시작하는지 확인 (이미 확인됨)
    // 3. 접두사 제거 후 나머지 환경변수명을 <ENV_NAME>으로 정의
    const envName = key.replace(/^process\.env\./, '');

    // 4. 값이 다음 형태인지 확인
    const isStringifyString = /JSON\.stringify\s*\(\s*["']([^"']+)["']\s*\)/.test(value);
    const isStringifyNumber = /JSON\.stringify\s*\(\s*(\d+(?:\.\d+)?)\s*\)/.test(value);
    const isStringLiteral = /^["']([^"']+)["']$/.test(value);
    const isNumberLiteral = /^\d+(?:\.\d+)?$/.test(value);

    if (isStringifyString || isStringifyNumber || isStringLiteral || isNumberLiteral) {
      // 5. 위 조건을 만족하면 코드 내 참조만 Next 표준으로 치환
      // 단, NODE_ENV인 경우 자동 치환하지 않음
      if (envName === 'NODE_ENV') {
        console.log(chalk.yellow('\n⚠️  define에서 process.env.NODE_ENV 치환이 발견되었습니다.'));
        console.log(chalk.yellow('   Next에서는 NODE_ENV가 빌드 시스템에 의해 자동 관리되므로 자동 변환하지 않습니다. 수동 확인이 필요합니다.'));
        continue;
      }

      matches.push({
        originalKey: key,
        envName: envName,
        nextPublicName: `NEXT_PUBLIC_${envName}`
      });
    }
  }

  if (matches.length === 0) {
    return;
  }

  // 5.1. 프로젝트 전체 .ts, .tsx에서 process.env.<ENV_NAME> 검색
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) {
    return;
  }

  async function findTsFiles(dir) {
    const files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', '.next', '.git'].includes(entry.name)) {
        files.push(...await findTsFiles(fullPath));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const tsFiles = await findTsFiles(srcDir);

  for (const filePath of tsFiles) {
    let content = await fs.readFile(filePath, 'utf-8');
    let modified = false;

    for (const match of matches) {
      // 5.2. process.env.<ENV_NAME>을 process.env.NEXT_PUBLIC_<ENV_NAME>으로 치환
      const regex = new RegExp(`process\\.env\\.${match.envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      if (regex.test(content)) {
        content = content.replace(regex, `process.env.${match.nextPublicName}`);
        modified = true;
      }
    }

    if (modified) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  // 6. 터미널에 메시지 기록
  for (const match of matches) {
    console.log(chalk.cyan(`\n💡 ${match.nextPublicName} 값을 환경변수로 제공해야 함`));
  }
}

// Case e: 복잡한 표현식 처리
async function handleComplexDefineExpressions(cwd, defineContent) {
  // 1. define 객체의 각 항목에 대해 값이 복잡 표현식인지 확인
  const complexItems = [];
  const keyValuePattern = /["']?([^"':\s]+)["']?\s*:\s*([^,}]+)/g;
  let match;

  while ((match = keyValuePattern.exec(defineContent)) !== null) {
    const key = match[1].trim();
    const value = match[2].trim();

    // 복잡 표현식 확인:
    // - 식별자 참조 (mode, import.meta, process)
    // - 함수 호출 (loadConfig(), getValue())
    // - 객체 리터럴 ({a:1})
    // - 삼항 연산자/논리 연산자 (a?b:c, a && b)
    const hasIdentifierRef = /\b(mode|import\.meta|process)\b/.test(value);
    const hasFunctionCall = /\w+\s*\([^)]*\)/.test(value);
    const hasObjectLiteral = /\{[^}]*\}/.test(value);
    const hasTernaryOrLogical = /[?&|]/.test(value);

    if (hasIdentifierRef || hasFunctionCall || hasObjectLiteral || hasTernaryOrLogical) {
      complexItems.push({
        key: key,
        value: value
      });
    }
  }

  if (complexItems.length === 0) {
    return;
  }

  // 2. 복잡 표현식 항목은 자동 이관하지 않음
  // 3. 터미널에 정보 기록
  console.log(chalk.yellow('\n⚠️  복잡한 define 표현식이 발견되었습니다.'));
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

  for (const item of complexItems) {
    console.log(chalk.yellow(`\n  define 키: ${item.key}`));
    console.log(chalk.yellow(`  원본 값 표현식: ${item.value}`));
  }

  console.log(chalk.cyan('\n📋 추천 대안 중 하나를 선택하세요:'));
  console.log(chalk.gray('  1. 런타임 환경변수로 이동 (Next Public/Server 구분 필요)'));
  console.log(chalk.gray('  2. src/config/*.ts 상수 모듈로 이동 (빌드 시 고정값이면)'));
  console.log(chalk.gray('  3. 서버에서만 필요한 값이면 Server Component/Route Handler에서 계산하도록 이동'));
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
}

// Case a-1: define이 없을 때 모든 파일에서 import.meta.env.VITE_* 변환
async function migrateImportMetaEnvInAllFiles(cwd) {
  // 2.1. 프로젝트 루트 기준으로 src/ 디렉터리 하위의 .ts, .tsx 파일을 대상으로 검사
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) {
    console.log(chalk.yellow(`⚠️  src 디렉터리를 찾을 수 없습니다: ${srcDir}`));
    return;
  }
  
  console.log(chalk.blue('   import.meta.env.VITE_* 패턴 변환 시작...'));

  async function findTsFiles(dir) {
    const files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', '.next', '.git'].includes(entry.name)) {
        files.push(...await findTsFiles(fullPath));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const tsFiles = await findTsFiles(srcDir);
  let processedCount = 0;

  // 2.2. 각 파일에서 import.meta.env.VITE_ 패턴 찾아서 치환
  for (const filePath of tsFiles) {
    let content = await fs.readFile(filePath, 'utf-8');
    
    // import.meta.env.VITE_ 패턴이 있는지 확인
    if (!content.includes('import.meta.env.VITE_')) {
      continue;
    }

    // 2.3. import.meta.env.VITE_<NAME> 형태를 찾아서 process.env.NEXT_PUBLIC_<NAME>으로 치환
    // 2.3.1. import.meta.env.VITE_<NAME> 형태를 찾는다
    // 2.3.2. 찾은 각 항목의 <NAME> 값을 추출한다
    // 2.3.3. 추출한 <NAME>에 대해 process.env.NEXT_PUBLIC_<NAME> 형태로 변경한다
    // 패턴: import.meta.env.VITE_ 다음에 알파벳, 숫자, 언더스코어가 오는 경우
    const pattern = /import\.meta\.env\.VITE_([A-Za-z0-9_]+)/g;
    const newContent = content.replace(pattern, (match, name) => {
      return `process.env.NEXT_PUBLIC_${name}`;
    });

    // 2.4. 치환 후 파일 내에 import.meta.env.VITE_ 문자열이 남아있는지 확인
    if (newContent !== content) {
      if (newContent.includes('import.meta.env.VITE_')) {
        console.warn(chalk.yellow(`⚠️  ${path.relative(cwd, filePath)}: 일부 import.meta.env.VITE_ 패턴이 남아있습니다.`));
      }
      await fs.writeFile(filePath, newContent, 'utf-8');
      processedCount++;
    }
  }

  if (processedCount > 0) {
    console.log(chalk.cyan(`   ✅ ${processedCount}개 파일에서 import.meta.env.VITE_* 패턴을 process.env.NEXT_PUBLIC_*로 변환했습니다.`));
  } else {
    console.log(chalk.gray(`   ℹ️  import.meta.env.VITE_* 패턴을 사용하는 파일이 없습니다.`));
  }
}

// Case f: import.meta.env.* 직접 치환 처리
async function migrateImportMetaEnvInDefine(cwd, defineContent) {
  // 1. define 객체의 키 중 문자열 리터럴로 작성된 키 찾기
  const importMetaEnvPattern = /["'](import\.meta\.env\.[A-Z_][A-Z0-9_]*)["']\s*:\s*([^,}]+)/g;
  const matches = [];
  let match;

  while ((match = importMetaEnvPattern.exec(defineContent)) !== null) {
    const key = match[1]; // import.meta.env.VITE_API_URL
    const value = match[2].trim();

    // 2. 키가 정확히 import.meta.env. 접두사로 시작하는지 확인 (이미 확인됨)
    // 3. 접두사 제거 후 나머지를 <VITE_NAME>으로 정의
    const viteName = key.replace(/^import\.meta\.env\./, ''); // VITE_API_URL

    // 4.1. VITE_ 접두사 제거하여 <PUBLIC_NAME> 정의
    const publicName = viteName.replace(/^VITE_/, ''); // API_URL

    // 4.2. 최종 변수명: NEXT_PUBLIC_<PUBLIC_NAME>
    const nextPublicName = `NEXT_PUBLIC_${publicName}`; // NEXT_PUBLIC_API_URL

    matches.push({
      originalKey: key,
      viteName: viteName,
      nextPublicName: nextPublicName
    });
  }

  if (matches.length === 0) {
    return;
  }

  // 3. 프로젝트 전체 .ts, .tsx에서 import.meta.env.<VITE_NAME> 검색
  const srcDir = path.join(cwd, 'src');
  if (!fs.existsSync(srcDir)) {
    return;
  }

  async function findTsFiles(dir) {
    const files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', '.next', '.git'].includes(entry.name)) {
        files.push(...await findTsFiles(fullPath));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const tsFiles = await findTsFiles(srcDir);

  for (const filePath of tsFiles) {
    let content = await fs.readFile(filePath, 'utf-8');
    let modified = false;

    for (const match of matches) {
      // 4. import.meta.env.<VITE_NAME>을 process.env.NEXT_PUBLIC_<PUBLIC_NAME>으로 치환
      const regex = new RegExp(`import\\.meta\\.env\\.${match.viteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      if (regex.test(content)) {
        content = content.replace(regex, `process.env.${match.nextPublicName}`);
        modified = true;
      }
    }

    if (modified) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  // 5. 터미널에 메시지 기록 (.env는 생성하지 않음)
  for (const match of matches) {
    console.log(chalk.cyan(`\n💡 ${match.nextPublicName} 값을 환경변수로 제공해야 함`));
  }
}

// =================================================================================================
// 5. TypeScript 설정 정리 (cwd 인자 추가) - 4번에서 이동
// =================================================================================================
async function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    // JSON 문자열 내부의 주석 패턴을 보호하면서 주석 제거
    // 방법: 문자열을 임시로 치환한 후 주석 제거, 다시 복원
    const stringPlaceholders = [];
    let cleanJson = content;
    let placeholderIndex = 0;
    
    // 문자열 리터럴을 임시 플레이스홀더로 치환
    cleanJson = cleanJson.replace(/"([^"\\]|\\.)*"/g, (match) => {
      const placeholder = `__STRING_${placeholderIndex}__`;
      stringPlaceholders[placeholderIndex] = match;
      placeholderIndex++;
      return placeholder;
    });
    
    // 이제 주석 제거 (문자열 외부에만 있음)
    // 줄 단위 주석 (//) 제거
    cleanJson = cleanJson.replace(/\/\/.*$/gm, '');
    // 블록 주석 (/* */) 제거
    cleanJson = cleanJson.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // 문자열 복원
    stringPlaceholders.forEach((str, index) => {
      cleanJson = cleanJson.replace(`__STRING_${index}__`, str);
    });
    
    // 빈 줄 정리
    cleanJson = cleanJson.replace(/\n\s*\n/g, '\n');
    
    return JSON.parse(cleanJson);
  } catch (e) {
    console.warn(chalk.yellow(`⚠️  JSON 파싱 실패: ${filePath} - ${e.message}`));
    return null;
  }
}

async function updateTsConfig(cwd) {
  // Case a: 참조 제거 (tsconfig.json의 files/references 정리)
  await removeTsConfigReferences(cwd);

  // Case b: tsconfig.app.json 설정 이관 및 통합
  const shouldContinue = await migrateTsConfigApp(cwd);
  
  // Case c: tsconfig.app.json 삭제
  // Case b에서 사용자가 계속 진행하기로 한 경우에만 삭제
  if (shouldContinue) {
    await deleteTsConfigApp(cwd);
  }
}

// Case a: 참조 제거 (tsconfig.json의 files/references 정리)
async function removeTsConfigReferences(cwd) {
  // 1. 프로젝트 루트의 tsconfig.json 파일을 연다
  const tsConfigPath = path.join(cwd, 'tsconfig.json');

  if (!fs.existsSync(tsConfigPath)) {
    return; // tsconfig.json이 없으면 종료
  }

  try {
    const tsConfig = await readJsonSafe(tsConfigPath);
    if (!tsConfig) {
      throw new Error('tsconfig.json 파싱 실패');
    }

    // 2. 최상위 키 중 "files"가 존재하면 해당 키를 삭제한다
    if (tsConfig.files !== undefined) {
      delete tsConfig.files;
    }

    // 3. 최상위 키 중 "references"가 존재하면 해당 키를 삭제한다
    if (tsConfig.references !== undefined) {
      delete tsConfig.references;
    }

    // 변경사항 저장
    await fs.writeJson(tsConfigPath, tsConfig, { spaces: 2 });
  } catch (e) {
    console.warn(chalk.yellow(`⚠️  tsconfig.json 수정 건너뜀: ${e.message}`));
  }
}

// Case b: tsconfig.app.json 설정 이관 및 통합
// 반환값: true = 계속 진행, false = 중단 또는 파일 없음
async function migrateTsConfigApp(cwd) {
  // 1. 대상 파일 확인
  // 프로젝트 루트에 tsconfig.app.json 파일이 존재하는지 확인한다
  const tsConfigAppPath = path.join(cwd, 'tsconfig.app.json');
  
  if (!fs.existsSync(tsConfigAppPath)) {
    return false; // 해당 파일이 존재하지 않으면 본 케이스 전체를 수행하지 않는다
  }

  const tsConfigPath = path.join(cwd, 'tsconfig.json');
  if (!fs.existsSync(tsConfigPath)) {
    return false; // tsconfig.json이 없으면 종료
  }

  try {
    const tsConfig = await readJsonSafe(tsConfigPath);
    if (!tsConfig) {
      throw new Error('tsconfig.json 파싱 실패');
    }

    const appConfig = await readJsonSafe(tsConfigAppPath);
    if (!appConfig) {
      throw new Error('tsconfig.app.json 파싱 실패');
    }

    // 2. tsconfig.app.json compilerOptions 설정을 Next 기준 tsconfig.json compilerOptions으로 재구성
    // 2.1. tsconfig.json compilerOptions 객체 생성
    if (!tsConfig.compilerOptions) {
      tsConfig.compilerOptions = {};
    }

    // 2.2. tsconfig.app.json의 compilerOptions 선별 및 복사
    // 2.2.1 유지 키 목록
    const keepKeys = [
      'target',
      'useDefineForClassFields',
      'lib',
      'module',
      'skipLibCheck',
      'moduleResolution',
      'noEmit',
      'jsx',
      'strict',
      'noUnusedLocals',
      'noUnusedParameters',
      'noFallthroughCasesInSwitch'
    ];

    // 2.2.2, 2.2.3: 위 유지 키 중 tsconfig.app.json에 존재하는 항목만 복사
    const appCompilerOptions = appConfig.compilerOptions || {};
    keepKeys.forEach((key) => {
      if (appCompilerOptions[key] !== undefined) {
        // tsconfig.json에 이미 존재하지 않는 경우에만 복사
        if (tsConfig.compilerOptions[key] === undefined) {
          tsConfig.compilerOptions[key] = appCompilerOptions[key];
        }
      }
    });

    // 2.3. Vite 전용 키 제외 (이미 위에서 제외됨 - keepKeys에 포함되지 않음)
    // 제외할 키: tsBuildInfoFile, types, allowImportingTsExtensions, verbatimModuleSyntax, 
    // moduleDetection, erasableSyntaxOnly, noUncheckedSideEffectImports

    // 2.4. Next.js 기준 compilerOptions 생성
    tsConfig.compilerOptions.allowJs = true;
    tsConfig.compilerOptions.resolveJsonModule = true;
    tsConfig.compilerOptions.isolatedModules = true;
    tsConfig.compilerOptions.forceConsistentCasingInFileNames = true;
    tsConfig.compilerOptions.esModuleInterop = true;
    tsConfig.compilerOptions.incremental = true;

    // 3. compilerOptions.jsx 값을 preserve로 변경
    // 3.1. tsconfig.json의 compilerOptions.jsx 값이 "react-jsx"인 경우 "preserve"로 변경한다
    if (tsConfig.compilerOptions.jsx === 'react-jsx') {
      tsConfig.compilerOptions.jsx = 'preserve';
    }
    // 이미 "preserve"이면 변경하지 않는다

    // 4. baseUrl, paths 설정 이관
    const conflictResult = await migrateBaseUrlAndPaths(cwd, tsConfig, appCompilerOptions);
    if (conflictResult.hasConflict) {
      // 충돌 발생 시 사용자에게 확인
      const shouldContinue = await askUserConfirmationForTsConfig(conflictResult.conflictType, conflictResult.conflictDetails);
      if (!shouldContinue) {
        // 사용자가 n을 입력한 경우 작업 중단
        return false;
      }
      // 사용자가 y를 입력한 경우 계속 진행 (충돌이 있어도 경고만 표시하고 진행)
    }

    // 5. include / exclude 설정 (Next 기준)
    // 5.1. tsconfig.json의 include를 Next 기준 목록으로 재구성
    tsConfig.include = [
      'next-env.d.ts',
      '**/*.ts',
      '**/*.tsx',
      '.next/types/**/*.ts'
    ];

    // 5.2. exclude 설정
    tsConfig.exclude = ['node_modules'];

    // 변경사항 저장
    await fs.writeJson(tsConfigPath, tsConfig, { spaces: 2 });
    
    // 정상 완료
    return true;
  } catch (e) {
    console.warn(chalk.yellow(`⚠️  tsconfig.app.json 이관 건너뜀: ${e.message}`));
    return false;
  }
}

// 4. baseUrl, paths 설정 이관
// 반환값: { hasConflict: boolean, conflictType: string, conflictDetails: object }
async function migrateBaseUrlAndPaths(cwd, tsConfig, appCompilerOptions) {
  // 4.1. tsconfig.app.json의 compilerOptions에서 baseUrl, paths가 존재한다면 확인
  const appBaseUrl = appCompilerOptions.baseUrl;
  const appPaths = appCompilerOptions.paths;

  // vite.config.ts의 resolve.alias도 확인 (충돌 체크용)
  // 방법론: vite.config.ts의 alias는 여기서 옮기지 않지만, 충돌 확인은 수행
  const viteConfigPath = path.join(cwd, 'vite.config.ts');
  let viteAliasPaths = null; // vite.config.ts의 alias를 paths 형태로 변환한 값
  
  if (fs.existsSync(viteConfigPath)) {
    try {
      const viteConfigContent = await fs.readFile(viteConfigPath, 'utf-8');
      // resolve.alias 패턴 찾기
      const aliasMatch = viteConfigContent.match(/resolve\s*:\s*\{[^}]*alias\s*:\s*\{([^}]+)\}/s);
      if (aliasMatch) {
        // alias 객체 추출
        const aliasContent = aliasMatch[1];
        viteAliasPaths = {};
        
        // 모든 alias 항목 찾기 (예: "@/": "src/" 또는 '@/': 'src/' 등)
        const aliasPattern = /["'`]([^"'`]+)["'`]\s*:\s*["'`]([^"'`]+)["'`]/g;
        let aliasItemMatch;
        
        while ((aliasItemMatch = aliasPattern.exec(aliasContent)) !== null) {
          const aliasKey = aliasItemMatch[1];
          const aliasValue = aliasItemMatch[2];
          // vite.config.ts의 alias는 문자열이지만, tsconfig의 paths는 배열이므로 변환
          // 예: "src/" → ["src/"]
          viteAliasPaths[aliasKey] = [aliasValue];
        }
      }
    } catch (e) {
      // vite.config.ts 파싱 실패는 무시
    }
  }

  // tsconfig.json에 이미 baseUrl 또는 paths가 존재하는지 확인
  const existingBaseUrl = tsConfig.compilerOptions.baseUrl;
  const existingPaths = tsConfig.compilerOptions.paths;

  // baseUrl 처리
  if (appBaseUrl !== undefined) {
    if (existingBaseUrl !== undefined) {
      if (existingBaseUrl !== appBaseUrl) {
        // 값이 다르면 충돌로 판단
        return {
          hasConflict: true,
          conflictType: 'baseUrl',
          conflictDetails: {
            existing: existingBaseUrl,
            new: appBaseUrl
          }
        };
      }
      // 값이 동일하면 유지
    } else {
      // 존재하지 않으면 추가
      tsConfig.compilerOptions.baseUrl = appBaseUrl;
    }
  }

  // paths 처리
  if (appPaths !== undefined) {
    if (existingPaths !== undefined) {
      // 기존 paths와 비교
      const existingPathsStr = JSON.stringify(existingPaths);
      const appPathsStr = JSON.stringify(appPaths);
      
      if (existingPathsStr !== appPathsStr) {
        // 값이 다르면 충돌로 판단
        return {
          hasConflict: true,
          conflictType: 'paths',
          conflictDetails: {
            existing: existingPaths,
            new: appPaths
          }
        };
      }
      // 값이 동일하면 유지
    } else {
      // 존재하지 않으면 추가
      tsConfig.compilerOptions.paths = appPaths;
    }
  }

  // vite.config.ts의 alias와 tsconfig.app.json의 paths 충돌 확인
  if (viteAliasPaths && appPaths) {
    // vite.config.ts의 alias를 paths 형태로 변환했으므로 비교 가능
    // 같은 키에 대해 값이 다르면 충돌로 판단
    for (const [aliasKey, aliasValue] of Object.entries(viteAliasPaths)) {
      if (appPaths[aliasKey]) {
        // 같은 키가 존재하는 경우 값 비교
        const appPathValue = appPaths[aliasKey];
        const aliasPathValue = aliasValue;
        
        // 배열 형태로 정규화하여 비교
        const appPathStr = JSON.stringify(Array.isArray(appPathValue) ? appPathValue : [appPathValue]);
        const aliasPathStr = JSON.stringify(aliasPathValue);
        
        if (appPathStr !== aliasPathStr) {
          // 값이 다르면 충돌로 판단
          return {
            hasConflict: true,
            conflictType: 'alias-paths',
            conflictDetails: {
              key: aliasKey,
              viteAlias: aliasValue[0],
              tsconfigAppPaths: appPathValue
            }
          };
        }
        // 값이 같거나 호환되면 정상 (예: "src/"와 ["src/"]는 같은 의미)
      }
    }
  }

  // tsconfig.json에 이미 paths가 있는 경우, vite.config.ts의 alias와도 비교
  if (viteAliasPaths && existingPaths) {
    for (const [aliasKey, aliasValue] of Object.entries(viteAliasPaths)) {
      if (existingPaths[aliasKey]) {
        const existingPathValue = existingPaths[aliasKey];
        const aliasPathValue = aliasValue;
        
        const existingPathStr = JSON.stringify(Array.isArray(existingPathValue) ? existingPathValue : [existingPathValue]);
        const aliasPathStr = JSON.stringify(aliasPathValue);
        
        if (existingPathStr !== aliasPathStr) {
          // 값이 다르면 충돌로 판단
          return {
            hasConflict: true,
            conflictType: 'alias-paths-existing',
            conflictDetails: {
              key: aliasKey,
              viteAlias: aliasValue[0],
              tsconfigPaths: existingPathValue
            }
          };
        }
      }
    }
  }

  return { hasConflict: false }; // 충돌 없음
}

// Case c: tsconfig.app.json 삭제
// Case b에서 tsconfig.app.json에 있던 필요한 설정을 tsconfig.json으로 반영 완료했기 때문에 tsconfig.app.json 파일은 삭제한다
async function deleteTsConfigApp(cwd) {
  // 프로젝트 루트에 tsconfig.app.json 파일이 존재하는지 확인
  const tsConfigAppPath = path.join(cwd, 'tsconfig.app.json');
  
  if (fs.existsSync(tsConfigAppPath)) {
    // 1. tsconfig.app.json 파일을 삭제한다
    await fs.remove(tsConfigAppPath);
  }
}

// TypeScript 설정 충돌 시 사용자 확인 함수
function askUserConfirmationForTsConfig(conflictType, conflictDetails) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // 충돌 타입에 따라 메시지 생성
    let message = '\n⚠️  TypeScript 설정 충돌 발생\n';
    message += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    if (conflictType === 'baseUrl') {
      message += `baseUrl 충돌:\n`;
      message += `  - tsconfig.json 기존: "${conflictDetails.existing}"\n`;
      message += `  - tsconfig.app.json: "${conflictDetails.new}"\n`;
    } else if (conflictType === 'paths') {
      message += `paths 충돌:\n`;
      message += `  - tsconfig.json 기존: ${JSON.stringify(conflictDetails.existing)}\n`;
      message += `  - tsconfig.app.json: ${JSON.stringify(conflictDetails.new)}\n`;
    } else if (conflictType === 'alias-paths') {
      message += `alias/paths 충돌:\n`;
      message += `  - 같은 키 "${conflictDetails.key}"에 대해 다른 값이 설정되어 있습니다.\n`;
      message += `  - vite.config.ts의 resolve.alias: "${conflictDetails.key}": "${conflictDetails.viteAlias}"\n`;
      message += `  - tsconfig.app.json의 paths: "${conflictDetails.key}": ${JSON.stringify(conflictDetails.tsconfigAppPaths)}\n`;
      message += `\n💡 참고:\n`;
      message += `  - vite.config.ts의 alias는 여기서 tsconfig.json으로 옮기지 않습니다.\n`;
      message += `  - tsconfig.app.json의 paths 값이 tsconfig.json에 적용됩니다.\n`;
      message += `  - vite.config.ts의 alias는 삭제되므로, 필요시 수동으로 tsconfig.json의 paths에 추가해주세요.\n`;
    } else if (conflictType === 'alias-paths-existing') {
      message += `alias/paths 충돌:\n`;
      message += `  - 같은 키 "${conflictDetails.key}"에 대해 다른 값이 설정되어 있습니다.\n`;
      message += `  - vite.config.ts의 resolve.alias: "${conflictDetails.key}": "${conflictDetails.viteAlias}"\n`;
      message += `  - tsconfig.json의 기존 paths: "${conflictDetails.key}": ${JSON.stringify(conflictDetails.tsconfigPaths)}\n`;
      message += `\n💡 참고:\n`;
      message += `  - vite.config.ts의 alias는 여기서 tsconfig.json으로 옮기지 않습니다.\n`;
      message += `  - tsconfig.json의 기존 paths 값이 유지됩니다.\n`;
      message += `  - vite.config.ts의 alias는 삭제되므로, 필요시 수동으로 tsconfig.json의 paths에 추가해주세요.\n`;
    }

    message += '\n계속 진행하시겠습니까? (y/n): ';

    rl.question(chalk.yellow(message), (answer) => {
      rl.close();
      const shouldContinue = answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes';
      resolve(shouldContinue);
    });
  });
}

module.exports = {
  updatePackageJson,
  setupConfigFiles,
  migrateViteConfig,
  migrateViteDefine,
  updateTsConfig,
};
