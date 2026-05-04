// src/step7/react-trace-cleaner.cjs
// 남겨둔 React 흔적 정리

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { spawnSync } = require('child_process');
const { detectPackageManager } = require('../utils/project-info.cjs');

function spawnInstall(cmd, args, cwd) {
  return spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

/**
 * eslint-config-next를 devDependency로 설치합니다.
 * npm은 peer dependency 충돌(ERESOLVE)이 자주 나므로 실패 시 --legacy-peer-deps로 1회 재시도합니다.
 * @returns {boolean} 설치 성공 여부
 */
function tryInstallEslintConfigNext(projectRoot) {
  const pm = detectPackageManager(projectRoot);

  if (pm === 'yarn') {
    const r = spawnInstall('yarn', ['add', '-D', 'eslint-config-next'], projectRoot);
    return r.status === 0;
  }
  if (pm === 'pnpm') {
    const r = spawnInstall('pnpm', ['add', '-D', 'eslint-config-next'], projectRoot);
    return r.status === 0;
  }
  if (pm === 'bun') {
    const r = spawnInstall('bun', ['add', '-d', 'eslint-config-next'], projectRoot);
    return r.status === 0;
  }

  const first = spawnInstall('npm', ['install', '-D', 'eslint-config-next'], projectRoot);
  if (first.status === 0) return true;

  console.log(
    chalk.yellow(
      '\n⚠️  npm install eslint-config-next 가 peer dependency 충돌로 실패했습니다. --legacy-peer-deps 로 재시도합니다.\n'
    )
  );
  const second = spawnInstall(
    'npm',
    ['install', '-D', 'eslint-config-next', '--legacy-peer-deps'],
    projectRoot
  );
  return second.status === 0;
}

//=========================================================
// React 흔적 정리 메인 함수
//=========================================================
async function cleanReactTrace(projectRoot) {
  // Case a: 앞 단계에서 지우지 않은 react 관련 잔여 파일 삭제
  await removeReactRemainingFiles(projectRoot);

  // Case b: tailwind 설정 정리
  await cleanTailwindConfig(projectRoot);

  // Case c: package.json 정리
  await cleanPackageJson(projectRoot);

  // Case d: React Router import 삭제
  await removeReactRouterImports(projectRoot);

  // Case e: React Helmet import 삭제
  await removeReactHelmetImports(projectRoot);

  // Case f: React Refresh import 삭제
  await removeReactRefreshImports(projectRoot);

  // Case g: React Router History import 삭제
  await removeReactRouterHistoryImports(projectRoot);
}

//=========================================================
// Case a: 앞 단계에서 지우지 않은 react 관련 잔여 파일 삭제
//=========================================================
async function removeReactRemainingFiles(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  
  // src/ 디렉터리가 존재하지 않으면 종료
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // 삭제할 파일 목록
  const filesToDelete = [
    'main.tsx',
    'App.tsx',
    'index.css',
    'App.css',
  ];

  // 각 파일이 존재하면 삭제
  for (const fileName of filesToDelete) {
    const filePath = path.join(srcDir, fileName);
    if (fs.existsSync(filePath)) {
      await fs.remove(filePath);
    }
  }

  // 프로젝트 루트의 index.html도 삭제
  const rootIndexHtmlPath = path.join(projectRoot, 'index.html');
  if (fs.existsSync(rootIndexHtmlPath)) {
    await fs.remove(rootIndexHtmlPath);
  }
}

//=========================================================
// Case b: tailwind 설정 정리
//=========================================================
async function cleanTailwindConfig(projectRoot) {
  const tailwindConfigPath = path.join(projectRoot, 'tailwind.config.js');
  
  // tailwind.config.js 파일이 존재하지 않으면 종료
  if (!fs.existsSync(tailwindConfigPath)) {
    return;
  }

  // 파일 읽기
  let content = await fs.readFile(tailwindConfigPath, 'utf-8');
  const originalContent = content;

  // content 배열 내부에서 "./index.html" 문자열 찾기 및 삭제
  // content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"] 형태를
  // content: ["./src/**/*.{js,ts,jsx,tsx}"] 형태로 변경
  
  // "./index.html" 패턴 찾기 (따옴표 종류 고려: 단일 따옴표, 이중 따옴표)
  // 배열 내부에서만 매칭되도록 content: [...] 패턴 내부를 찾음
  const indexHtmlPatterns = [
    // 이중 따옴표: "./index.html"
    /(["']\.\/index\.html["'])\s*,?\s*/g,
    // 단일 따옴표: './index.html'
    /(['"]\.\/index\.html['"])\s*,?\s*/g,
  ];
  
  let hasChanges = false;
  for (const pattern of indexHtmlPatterns) {
    if (pattern.test(content)) {
      // 패턴이 존재하면 삭제
      content = content.replace(pattern, '');
      hasChanges = true;
    }
  }
  
  if (hasChanges) {
    // 배열 내부의 연속된 쉼표 정리
    // 예: ["./src/**/*.{js,ts,jsx,tsx}", ,] -> ["./src/**/*.{js,ts,jsx,tsx}"]
    content = content.replace(/,\s*,/g, ',');
    // 배열 시작 부분의 쉼표 제거: [ , "./src/..."] -> ["./src/..."]
    content = content.replace(/\[\s*,/g, '[');
    // 배열 끝 부분의 쉼표 제거: ["./src/...", ] -> ["./src/..."]
    content = content.replace(/,\s*\]/g, ']');
    
    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(tailwindConfigPath, content, 'utf-8');
    }
  }
}

//=========================================================
// Case c: package.json 정리
//=========================================================
async function cleanPackageJson(projectRoot) {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  
  // package.json 파일이 존재하지 않으면 종료
  if (!fs.existsSync(packageJsonPath)) {
    return;
  }

  // package.json 읽기
  const packageJson = await fs.readJson(packageJsonPath);
  let hasChanges = false;

  // 1. dependencies 객체 내부 키를 검사하여 삭제할 키 목록
  const dependenciesToDelete = [
    'react-router',
    'react-router-dom',
    'react-helmet',
    'react-helmet-async',
  ];

  // dependencies에서 삭제
  if (packageJson.dependencies) {
    for (const key of dependenciesToDelete) {
      if (packageJson.dependencies[key]) {
        delete packageJson.dependencies[key];
        hasChanges = true;
      }
    }
  }

  // 2. devDependencies 객체 내부 키를 검사하여 삭제할 키 목록
  const devDependenciesToDelete = [
    '@types/react-helmet',
    '@vitejs/plugin-react',
    'vite',
    'vite-plugin-svgr',
    'vite-plugin-env-compatible',
    'eslint-plugin-react-refresh',
  ];

  // devDependencies에서 삭제
  if (packageJson.devDependencies) {
    for (const key of devDependenciesToDelete) {
      if (packageJson.devDependencies[key]) {
        delete packageJson.devDependencies[key];
        hasChanges = true;
      }
    }
  }

  // 3. eslint-config-next가 devDependencies에 존재하는지 확인
  if (!packageJson.devDependencies) {
    packageJson.devDependencies = {};
  }

  const hasEslintConfigNext = Boolean(packageJson.devDependencies['eslint-config-next']);

  // 변경사항이 있으면 파일 저장
  if (hasChanges) {
    await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
  }

  // 4. eslint-config-next가 없으면 실제 설치 명령 실행
  if (!hasEslintConfigNext) {
    const installedOk = tryInstallEslintConfigNext(projectRoot);

    // 설치 실패 시 최소한 package.json에는 반영되도록 fallback (node_modules에는 없을 수 있음)
    if (!installedOk) {
      const fallbackPackageJson = await fs.readJson(packageJsonPath);
      if (!fallbackPackageJson.devDependencies) {
        fallbackPackageJson.devDependencies = {};
      }
      if (!fallbackPackageJson.devDependencies['eslint-config-next']) {
        fallbackPackageJson.devDependencies['eslint-config-next'] = 'latest';
        await fs.writeJson(packageJsonPath, fallbackPackageJson, { spaces: 2 });
      }

      console.log(
        chalk.yellow.bold('\n⚠️  React 흔적 정리: eslint-config-next 자동 설치에 실패했습니다.\n') +
          chalk.yellow(
            '   마이그레이션 단계 자체는 계속 진행되지만, ESLint용 패키지는 아직 설치되지 않았을 수 있습니다.\n\n' +
              '   흔한 원인:\n' +
              '   • npm ERESOLVE: next와 react/react-dom 버전이 peer dependency 규칙과 맞지 않음\n' +
              '   • 로그에 "react@undefined"가 보이면 package-lock.json 과 package.json 불일치 또는 손상 가능성\n\n' +
              '   수동으로 프로젝트 루트에서 다음을 시도하세요:\n' +
              `   • npm:  npm install -D eslint-config-next --legacy-peer-deps\n` +
              `   • 또는: npm install --legacy-peer-deps\n` +
              `   • yarn/pnpm 사용 시: 해당 도구로 eslint-config-next 추가 후 install\n\n` +
              '   (Node가 spawn 시 shell 옵션 경고를 내면 DEP0190 — 보안 권고일 뿐, 위 npm 실패와는 별개입니다.)\n'
          )
      );
    }
  }
}

//=========================================================
// Case d: React Router import 삭제
//=========================================================
async function removeReactRouterImports(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  
  // src/ 디렉터리가 존재하지 않으면 종료
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // src/ 디렉터리 하위의 모든 .ts, .tsx 파일 찾기
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

  // 파일 내 React Router import 삭제
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // import ... from "react-router-dom" 패턴 찾기 및 삭제
    const reactRouterPattern = /import\s+[\s\S]*?\s+from\s+["']react-router-dom["'];?\s*\r?\n?/g;
    
    if (reactRouterPattern.test(content)) {
      content = content.replace(reactRouterPattern, '');
      
      // 변경사항이 있으면 파일 저장
      if (content !== originalContent) {
        await fs.writeFile(filePath, content, 'utf-8');
      }
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case e: React Helmet import 삭제
//=========================================================
async function removeReactHelmetImports(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  
  // src/ 디렉터리가 존재하지 않으면 종료
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // src/ 디렉터리 하위의 모든 .ts, .tsx 파일 찾기
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

  // Step3 commentOutHelmet이 남긴 JSX 블록 주석( Migrated to Next.js Metadata API … ) 안의
  // <Helmet> 문자열은 텍스트일 뿐인데, helmetPattern이 다시 잡으면 TODO용 JSX 주석을
  // 안쪽에 넣어 주석이 깨지고 닫는 토큰( star + slash + } ) 중복 등 구문 오류가 난다.
  // 블록 주석 안에 star-slash 를 쓰면 편집기가 주석을 중간에 끊으므로 여기서는 // 로만 설명한다.
  function indexInsideMigratedMetadataJsxComment(src, idx) {
    const marker = 'Migrated to Next.js Metadata API';
    let from = 0;
    while (from < src.length) {
      const mPos = src.indexOf(marker, from);
      if (mPos === -1) return false;
      const commentOpen = src.lastIndexOf('{/*', mPos);
      if (commentOpen === -1 || commentOpen > mPos) {
        from = mPos + marker.length;
        continue;
      }
      const close = src.indexOf('*/}', commentOpen);
      if (close === -1) return false;
      if (idx >= commentOpen && idx <= close + 2) return true;
      from = close + 3;
    }
    return false;
  }

  // 파일 내 React Helmet import 삭제 및 사용 코드 제거
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // import ... from "react-helmet" 패턴 찾기 및 삭제
    // 주의: 모듈 문자열 앞의 quote를 넘지 않도록 [^'"]를 사용해 다른 import까지 먹지 않게 함
    const reactHelmetPattern = /^\s*import\s+[^'"]+\s+from\s+["']react-helmet["'];?\s*\r?\n?/gm;
    // import ... from "react-helmet-async" 패턴 찾기 및 삭제
    const reactHelmetAsyncPattern = /^\s*import\s+[^'"]+\s+from\s+["']react-helmet-async["'];?\s*\r?\n?/gm;
    
    let hasChanges = false;
    if (reactHelmetPattern.test(content)) {
      content = content.replace(reactHelmetPattern, '');
      hasChanges = true;
    }
    if (reactHelmetAsyncPattern.test(content)) {
      content = content.replace(reactHelmetAsyncPattern, '');
      hasChanges = true;
    }

    // HelmetProvider 사용 코드 제거
    // <HelmetProvider>...</HelmetProvider> 패턴 찾기 및 제거
    const helmetProviderPattern = /<HelmetProvider[^>]*>([\s\S]*?)<\/HelmetProvider>/g;
    const afterProvider = content.replace(helmetProviderPattern, (match, children) =>
      children.trim()
    );
    if (afterProvider !== content) {
      content = afterProvider;
      hasChanges = true;
    }

    // Helmet 사용 코드 제거 (주석 중첩으로 JSX 파싱이 깨질 수 있어 주석화 대신 제거)
    // <Helmet>...</Helmet> 패턴 찾기 및 제거
    const helmetPattern = /<Helmet[^>]*>([\s\S]*?)<\/Helmet>/g;
    const afterHelmet = content.replace(helmetPattern, (match, _inner, offset) => {
      if (indexInsideMigratedMetadataJsxComment(content, offset)) {
        return match;
      }
      return '';
    });
    if (afterHelmet !== content) {
      content = afterHelmet;
      hasChanges = true;
    }
    
    // 변경사항이 있으면 파일 저장
    if (hasChanges && content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case f: React Refresh import 삭제
//=========================================================
async function removeReactRefreshImports(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  
  // src/ 디렉터리가 존재하지 않으면 종료
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // src/ 디렉터리 하위의 모든 .ts, .tsx 파일 찾기
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

  // 파일 내 React Refresh import 삭제
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // import RefreshRuntime from "react-refresh/runtime" 패턴 찾기 및 삭제
    const refreshRuntimePattern1 = /import\s+RefreshRuntime\s+from\s+["']react-refresh\/runtime["'];?\s*\r?\n?/g;
    // import "react-refresh/runtime" 패턴 찾기 및 삭제
    const refreshRuntimePattern2 = /import\s+["']react-refresh\/runtime["'];?\s*\r?\n?/g;
    
    let hasChanges = false;
    if (refreshRuntimePattern1.test(content)) {
      content = content.replace(refreshRuntimePattern1, '');
      hasChanges = true;
    }
    if (refreshRuntimePattern2.test(content)) {
      content = content.replace(refreshRuntimePattern2, '');
      hasChanges = true;
    }
    
    // 변경사항이 있으면 파일 저장
    if (hasChanges && content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case g: React Router History import 삭제
//=========================================================
async function removeReactRouterHistoryImports(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  
  // src/ 디렉터리가 존재하지 않으면 종료
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // src/ 디렉터리 하위의 모든 .ts, .tsx 파일 찾기
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

  // 파일 내 React Router History import 삭제
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // import { createBrowserHistory } from "history" 패턴 찾기 및 삭제
    const historyPattern1 = /import\s+\{\s*createBrowserHistory\s*\}\s+from\s+["']history["'];?\s*\r?\n?/g;
    // import history from "history" 패턴 찾기 및 삭제
    const historyPattern2 = /import\s+history\s+from\s+["']history["'];?\s*\r?\n?/g;
    
    let hasChanges = false;
    if (historyPattern1.test(content)) {
      content = content.replace(historyPattern1, '');
      hasChanges = true;
    }
    if (historyPattern2.test(content)) {
      content = content.replace(historyPattern2, '');
      hasChanges = true;
    }
    
    // 변경사항이 있으면 파일 저장
    if (hasChanges && content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

module.exports = {
  cleanReactTrace,
};