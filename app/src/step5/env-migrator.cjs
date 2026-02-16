// src/step5/env-migrator.cjs
// Vite 환경변수 (import.meta.env) 접근 코드 변환 모듈

const fs = require('fs-extra');
const path = require('path');

//=========================================================
// Vite 환경변수 마이그레이션 메인 함수
//=========================================================
async function migrateImportMetaEnvToNextPublicEnv(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  if (!fs.existsSync(srcDir)) {
    return {
      totalFiles: 0,
      processedFiles: [],
    };
  }

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];

    if (!fs.existsSync(dir)) {
      return files;
    }

    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const resolvedPath = path.resolve(fullPath);

      if (item.isDirectory()) {
        // node_modules, .next 등 제외
        if (item.name.startsWith('.') || item.name === 'node_modules') {
          continue;
        }
        const subFiles = await findTsFiles(fullPath);
        files.push(...subFiles);
      } else if (item.isFile()) {
        // .ts, .tsx 파일만 대상
        if (/\.tsx?$/.test(item.name)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  // 2. 각 파일에서 import.meta.env.VITE_ 패턴 찾아서 치환
  async function processFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');

    // import.meta.env.VITE_ 패턴이 있는지 확인
    if (!content.includes('import.meta.env.VITE_')) {
      return false;
    }

    // 3.1. import.meta.env.VITE_<NAME> 형태를 찾는다
    // 정규식: import.meta.env.VITE_<NAME> (NAME은 알파벳, 숫자, 언더스코어로 구성)
    const pattern = /import\.meta\.env\.VITE_([A-Za-z0-9_]+)/g;
    let modified = false;
    let newContent = content;

    // 3.2. 찾은 각 항목의 <NAME> 값을 추출하고
    // 3.3. process.env.NEXT_PUBLIC_<NAME> 형태로 변경
    newContent = newContent.replace(pattern, (match, name) => {
      modified = true;
      return `process.env.NEXT_PUBLIC_${name}`;
    });

    // 4. 치환 후 파일 내에 import.meta.env.VITE_ 문자열이 남아있는지 확인
    if (modified) {
      // 치환이 완료되었는지 확인
      if (newContent.includes('import.meta.env.VITE_')) {
        console.warn(`⚠️  ${filePath}: 일부 import.meta.env.VITE_ 패턴이 남아있습니다.`);
      }

      // 파일 저장
      await fs.writeFile(filePath, newContent, 'utf-8');
      return true;
    }

    return false;
  }

  // 모든 .ts, .tsx 파일 처리
  const tsFiles = await findTsFiles(srcDir);
  const processedFiles = [];

  for (const filePath of tsFiles) {
    const processed = await processFile(filePath);
    if (processed) {
      // 프로젝트 루트 기준 상대 경로로 변환
      const relativePath = path.relative(projectRoot, filePath);
      processedFiles.push(relativePath);
    }
  }

  return {
    totalFiles: tsFiles.length,
    processedFiles: processedFiles,
  };
}

module.exports = { migrateImportMetaEnvToNextPublicEnv };

