// src/step4/globalcss-migrator.cjs
// Global CSS 파일 마이그레이션: global.css, index.css, App.css -> src/app/global.css

const fs = require('fs-extra');
const path = require('path');

//=========================================================
//Global CSS 마이그레이션 메인 함수
//=========================================================
async function migrateGlobalCss(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const appDir = path.join(srcDir, 'app');
  const globalCssPath = path.join(appDir, 'global.css');

  // Case a: 기존 global.css 존재하는 경우
  await handleExistingGlobalCss(projectRoot, globalCssPath);

  // Case b: index.css 또는 App.css 사용 중인 경우
  await handleIndexAndAppCss(projectRoot, globalCssPath);
}

//=========================================================
//Case a: 기존 global.css 존재하는 경우
//=========================================================
async function handleExistingGlobalCss(projectRoot, globalCssPath) {
  const srcDir = path.join(projectRoot, 'src');

  // 1. src/app/global.css 파일 생성 (없으면)
  await fs.ensureFile(globalCssPath);

  // 2. src/global.css 또는 src/styles/global.css 파일 확인
  const globalCssSrc1 = path.join(srcDir, 'global.css');
  const globalCssSrc2 = path.join(srcDir, 'styles', 'global.css');
  
  let sourceGlobalCssPath = null;
  if (fs.existsSync(globalCssSrc1)) {
    sourceGlobalCssPath = globalCssSrc1;
  } else if (fs.existsSync(globalCssSrc2)) {
    sourceGlobalCssPath = globalCssSrc2;
  }

  // 파일이 없으면 Case b로 넘어감
  if (!sourceGlobalCssPath) {
    return;
  }

  // 3. 파일 내용 읽기
  const content = await fs.readFile(sourceGlobalCssPath, 'utf-8');

  // 4. src/app/global.css에 내용 쓰기
  await fs.writeFile(globalCssPath, content, 'utf-8');

  // 5. 기존 React 엔트리 파일에서 global.css import 구문 삭제
  async function removeGlobalCssImports(projectRoot, sourceGlobalCssPath) {
    const srcDir = path.join(projectRoot, 'src');
    
    // main.tsx 또는 index.tsx 파일 확인
    const mainTsxPath = path.join(srcDir, 'main.tsx');
    const indexTsxPath = path.join(srcDir, 'index.tsx');
    
    const entryFilePath = fs.existsSync(mainTsxPath) ? mainTsxPath : 
                         fs.existsSync(indexTsxPath) ? indexTsxPath : null;

    if (!entryFilePath) {
      return;
    }

    // 파일 내용 읽기
    let content = await fs.readFile(entryFilePath, 'utf-8');

    // sourceGlobalCssPath의 상대 경로 계산
    const relativePath = path.relative(srcDir, sourceGlobalCssPath);
    const normalizedPath = relativePath.replace(/\\/g, '/');
    
    // import 구문 패턴 찾기 및 삭제
    // "./global.css", './global.css', "./styles/global.css", './styles/global.css' 등
    const importPatterns = [
      new RegExp(`import\\s+["']\\.?/?${normalizedPath.replace(/\./g, '\\.')}["'];?\\s*\\n?`, 'g'),
      new RegExp(`import\\s+["']\\./global\\.css["'];?\\s*\\n?`, 'g'),
      new RegExp(`import\\s+["']\\./styles/global\\.css["'];?\\s*\\n?`, 'g'),
    ];

    importPatterns.forEach(pattern => {
      content = content.replace(pattern, '');
    });

    // 파일 저장
    await fs.writeFile(entryFilePath, content, 'utf-8');
  }
  await removeGlobalCssImports(projectRoot, sourceGlobalCssPath);
}

//=========================================================
//Case b: index.css 또는 App.css 사용 중인 경우
//=========================================================
async function handleIndexAndAppCss(projectRoot, globalCssPath) {
  const srcDir = path.join(projectRoot, 'src');
  const appDir = path.join(srcDir, 'app');
  
  // src/app/global.css 파일이 없으면 생성
  await fs.ensureFile(globalCssPath);

  let globalCssContent = '';
  if (fs.existsSync(globalCssPath)) {
    globalCssContent = await fs.readFile(globalCssPath, 'utf-8');
  }

  // 1. src/index.css 내용 추가
  const indexCssPath = path.join(srcDir, 'index.css');
  if (fs.existsSync(indexCssPath)) {
    const indexCssContent = await fs.readFile(indexCssPath, 'utf-8');
    if (globalCssContent && !globalCssContent.endsWith('\n')) {
      globalCssContent += '\n';
    }
    globalCssContent += indexCssContent;
    if (!globalCssContent.endsWith('\n')) {
      globalCssContent += '\n';
    }
  }

  // 2. src/App.css 내용 추가
  const appCssPath = path.join(srcDir, 'App.css');
  if (fs.existsSync(appCssPath)) {
    const appCssContent = await fs.readFile(appCssPath, 'utf-8');
    if (globalCssContent && !globalCssContent.endsWith('\n')) {
      globalCssContent += '\n';
    }
    globalCssContent += appCssContent;
    if (!globalCssContent.endsWith('\n')) {
      globalCssContent += '\n';
    }
  }

  // global.css 파일에 내용 쓰기
  if (globalCssContent) {
    await fs.writeFile(globalCssPath, globalCssContent, 'utf-8');
  }

  // 3. src/app/layout.tsx에 import "./global.css"; 추가 (없으면)
  async function ensureGlobalCssImportInLayout(projectRoot) {
    const layoutPath = path.join(projectRoot, 'src', 'app', 'layout.tsx');
    if (!fs.existsSync(layoutPath)) {
      return; // layout.tsx가 없으면 건너뜀
    }
    let content = await fs.readFile(layoutPath, 'utf-8');
    // 이미 import "./global.css"; 가 있는지 확인
    if (content.includes('import "./global.css"') || content.includes("import './global.css'")) {
      return;
    }
    // import 구문 영역 찾기 (파일 최상단)
    // 첫 번째 import 구문 앞에 추가
    const lines = content.split('\n');
    let insertIndex = 0;
    // 첫 번째 import 구문 위치 찾기
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('import ')) {
        insertIndex = i;
        break;
      }
    }
    // import "./global.css"; 추가
    lines.splice(insertIndex, 0, 'import "./global.css";');
    content = lines.join('\n');
    await fs.writeFile(layoutPath, content, 'utf-8');
  }
  await ensureGlobalCssImportInLayout(projectRoot);

  // 4. src/main.tsx 또는 src/index.tsx에서 import "./index.css"; 삭제
  async function removeIndexCssImport(projectRoot) {
    const srcDir = path.join(projectRoot, 'src');
    const mainTsxPath = path.join(srcDir, 'main.tsx');
    const indexTsxPath = path.join(srcDir, 'index.tsx');
    const entryFilePath = fs.existsSync(mainTsxPath) ? mainTsxPath : 
                         fs.existsSync(indexTsxPath) ? indexTsxPath : null;
    if (!entryFilePath) {
      return;
    }
    let content = await fs.readFile(entryFilePath, 'utf-8');
    // import "./index.css"; 또는 import './index.css'; 패턴 삭제
    const importPattern = /import\s+["']\.\/index\.css["'];?\s*\n?/g;
    content = content.replace(importPattern, '');
    await fs.writeFile(entryFilePath, content, 'utf-8');
  }
  await removeIndexCssImport(projectRoot);

  // 5. src/App.tsx에서 import "./App.css"; 삭제
  async function removeAppCssImport(projectRoot) {
    const appTsxPath = path.join(projectRoot, 'src', 'App.tsx');
    if (!fs.existsSync(appTsxPath)) {
      return;
    }
    let content = await fs.readFile(appTsxPath, 'utf-8');
    // import "./App.css"; 또는 import './App.css'; 패턴 삭제
    const importPattern = /import\s+["']\.\/App\.css["'];?\s*\n?/g;
    content = content.replace(importPattern, '');
    await fs.writeFile(appTsxPath, content, 'utf-8');
  }
  await removeAppCssImport(projectRoot);
}

module.exports = {
  migrateGlobalCss,
};

