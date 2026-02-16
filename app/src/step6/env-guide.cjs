// src/step6/env-guide.cjs
// 환경 변수 설정 & node_modules 갱신 가이드 모듈

const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');

// ============================================================================
// 1. 환경 변수 설정 가이드
// ============================================================================

/**
 * 환경 변수 마이그레이션 가이드 제공
 * - .env → .env.local 변경 안내
 * - .gitignore 설정 안내
 * - VITE_ → NEXT_PUBLIC_ 접두어 변경 안내
 */
async function guideEnvMigration(projectRoot) {
  console.log(chalk.blue.bold('\n📋 환경 변수 마이그레이션 가이드'));
  console.log(chalk.gray('─'.repeat(50)));

  // .env 파일 존재 여부 확인
  const envFiles = await findEnvFiles(projectRoot);
  const viteEnvVars = await findViteEnvVariables(projectRoot);

  // 1. 파일명 변경 안내
  console.log(chalk.yellow.bold('\n1️⃣  파일명 변경'));
  if (envFiles.length > 0) {
    console.log(chalk.white('   발견된 환경 변수 파일:'));
    envFiles.forEach(file => {
      console.log(chalk.cyan(`      - ${path.relative(projectRoot, file)}`));
    });
    console.log();
    console.log(chalk.white('   Next.js에서는 로컬 환경 변수 파일로 ') + chalk.green('.env.local') + chalk.white('을 사용합니다.'));
    console.log(chalk.white('   다음 명령어로 파일명을 변경하세요:\n'));
    
    if (envFiles.some(f => path.basename(f) === '.env')) {
      console.log(chalk.bgBlack.white('   mv .env .env.local'));
    }
    if (envFiles.some(f => path.basename(f) === '.env.development')) {
      console.log(chalk.bgBlack.white('   mv .env.development .env.development.local'));
    }
    if (envFiles.some(f => path.basename(f) === '.env.production')) {
      console.log(chalk.bgBlack.white('   mv .env.production .env.production.local'));
    }
  } else {
    console.log(chalk.gray('   .env 파일이 발견되지 않았습니다.'));
  }

  // 2. .gitignore 설정 안내
  console.log(chalk.yellow.bold('\n2️⃣  보안 설정 (.gitignore)'));
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const hasGitignore = fs.existsSync(gitignorePath);
  
  if (hasGitignore) {
    const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
    const hasEnvLocal = gitignoreContent.includes('.env.local') || gitignoreContent.includes('.env*.local');
    
    if (hasEnvLocal) {
      console.log(chalk.green('   ✓ .gitignore에 .env.local이 이미 포함되어 있습니다.'));
    } else {
      console.log(chalk.white('   .env.local 파일이 Git에 업로드되지 않도록 .gitignore에 추가하세요:\n'));
      console.log(chalk.bgBlack.white('   # Local Env Files'));
      console.log(chalk.bgBlack.white('   .env.local'));
      console.log(chalk.bgBlack.white('   .env*.local'));
    }
  } else {
    console.log(chalk.white('   .gitignore 파일을 생성하고 다음 내용을 추가하세요:\n'));
    console.log(chalk.bgBlack.white('   # Local Env Files'));
    console.log(chalk.bgBlack.white('   .env.local'));
    console.log(chalk.bgBlack.white('   .env*.local'));
  }

  // 3. 환경 변수 접두어 변경 안내
  console.log(chalk.yellow.bold('\n3️⃣  환경 변수 접두어 변경'));
  console.log(chalk.white('   브라우저에서 접근 가능한 환경 변수의 접두어를 변경해야 합니다:'));
  console.log(chalk.red('      VITE_') + chalk.white(' → ') + chalk.green('NEXT_PUBLIC_'));
  console.log();

  if (viteEnvVars.length > 0) {
    console.log(chalk.white('   발견된 VITE_ 접두어 변수:'));
    viteEnvVars.forEach(({ file, variables }) => {
      console.log(chalk.cyan(`\n   📄 ${path.relative(projectRoot, file)}`));
      variables.forEach(v => {
        const newName = v.replace('VITE_', 'NEXT_PUBLIC_');
        console.log(chalk.red(`      ${v}`) + chalk.white(' → ') + chalk.green(newName));
      });
    });
    
    console.log(chalk.yellow('\n   ⚠️  주의: 코드에서 사용하는 환경 변수 참조도 함께 수정해야 합니다!'));
    console.log(chalk.white('      예시: ') + chalk.red('import.meta.env.VITE_API_URL'));
    console.log(chalk.white('         → ') + chalk.green('process.env.NEXT_PUBLIC_API_URL'));
  } else {
    console.log(chalk.gray('   VITE_ 접두어 환경 변수가 발견되지 않았습니다.'));
  }

  console.log(chalk.gray('\n' + '─'.repeat(50)));
}

/**
 * 프로젝트에서 .env 파일들 찾기
 */
async function findEnvFiles(projectRoot) {
  const envFilePatterns = ['.env', '.env.local', '.env.development', '.env.production', '.env.test'];
  const foundFiles = [];

  for (const pattern of envFilePatterns) {
    const filePath = path.join(projectRoot, pattern);
    if (fs.existsSync(filePath)) {
      foundFiles.push(filePath);
    }
  }

  return foundFiles;
}

/**
 * VITE_ 접두어 환경 변수 찾기
 */
async function findViteEnvVariables(projectRoot) {
  const results = [];
  const envFiles = await findEnvFiles(projectRoot);

  for (const filePath of envFiles) {
    const content = await fs.readFile(filePath, 'utf-8');
    const viteVars = [];
    
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^(VITE_\w+)\s*=/);
      if (match) {
        viteVars.push(match[1]);
      }
    }

    if (viteVars.length > 0) {
      results.push({ file: filePath, variables: viteVars });
    }
  }

  // 소스 코드에서도 VITE_ 사용 확인
  const srcDir = path.join(projectRoot, 'src');
  if (fs.existsSync(srcDir)) {
    const sourceViteVars = await findViteEnvInSource(srcDir);
    if (sourceViteVars.length > 0) {
      // 중복 제거
      const envViteVars = results.flatMap(r => r.variables);
      const uniqueSourceVars = sourceViteVars.filter(v => !envViteVars.includes(v));
      
      if (uniqueSourceVars.length > 0) {
        results.push({ file: path.join(projectRoot, 'src/**/*.{ts,tsx,js,jsx}'), variables: uniqueSourceVars });
      }
    }
  }

  return results;
}

/**
 * 소스 코드에서 VITE_ 환경 변수 참조 찾기
 */
async function findViteEnvInSource(srcDir) {
  const viteVars = new Set();
  
  async function scanDirectory(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        await scanDirectory(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        const matches = content.matchAll(/import\.meta\.env\.(VITE_\w+)/g);
        for (const match of matches) {
          viteVars.add(match[1]);
        }
      }
    }
  }

  await scanDirectory(srcDir);
  return Array.from(viteVars);
}

// ============================================================================
// 2. 의존성 갱신 가이드
// ============================================================================

/**
 * 의존성 재설치 가이드 제공
 * - node_modules 삭제 명령어 안내
 * - 패키지 재설치 명령어 안내
 */
async function guideDependencyReset(projectRoot) {
  console.log(chalk.blue.bold('\n📋 의존성 갱신 가이드'));
  console.log(chalk.gray('─'.repeat(50)));

  // 패키지 매니저 감지
  const pm = detectPackageManager(projectRoot);
  const lockFile = getLockFileName(pm);

  // 1. 기존 모듈 제거 명령
  console.log(chalk.yellow.bold('\n1️⃣  기존 모듈 제거'));
  console.log(chalk.white('   Vite 환경에서 설치된 기존 node_modules와 캐시 파일을 삭제합니다.\n'));
  
  // OS별 명령어 제공
  console.log(chalk.cyan('   📌 macOS / Linux:'));
  console.log(chalk.bgBlack.white(`   rm -rf node_modules ${lockFile}`));
  console.log();
  console.log(chalk.cyan('   📌 Windows (PowerShell):'));
  console.log(chalk.bgBlack.white(`   Remove-Item -Recurse -Force node_modules, ${lockFile}`));
  console.log();
  console.log(chalk.cyan('   📌 Windows (CMD):'));
  console.log(chalk.bgBlack.white(`   rmdir /s /q node_modules && del ${lockFile}`));

  // 2. Next.js 모듈 설치 명령
  console.log(chalk.yellow.bold('\n2️⃣  Next.js 모듈 설치'));
  console.log(chalk.white('   Next.js 종속성이 반영된 새로운 패키지를 설치합니다.\n'));
  
  const installCmd = getInstallCommand(pm);
  console.log(chalk.bgBlack.white(`   ${installCmd}`));

  // 추가 안내
  console.log(chalk.yellow.bold('\n3️⃣  캐시 정리 (선택사항)'));
  console.log(chalk.white('   문제가 지속되면 패키지 매니저 캐시를 정리하세요:\n'));
  
  if (pm === 'npm') {
    console.log(chalk.bgBlack.white('   npm cache clean --force'));
  } else if (pm === 'yarn') {
    console.log(chalk.bgBlack.white('   yarn cache clean'));
  } else if (pm === 'pnpm') {
    console.log(chalk.bgBlack.white('   pnpm store prune'));
  }

  console.log(chalk.gray('\n' + '─'.repeat(50)));

  // 요약 출력
  console.log(chalk.green.bold('\n📝 전체 실행 순서 요약:\n'));
  console.log(chalk.white(`   1. rm -rf node_modules ${lockFile}`));
  console.log(chalk.white(`   2. ${installCmd}`));
  console.log(chalk.white('   3. npm run dev (또는 yarn dev, pnpm dev)'));
}

/**
 * 패키지 매니저 감지
 */
function detectPackageManager(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * lock 파일명 반환
 */
function getLockFileName(pm) {
  switch (pm) {
    case 'yarn': return 'yarn.lock';
    case 'pnpm': return 'pnpm-lock.yaml';
    default: return 'package-lock.json';
  }
}

/**
 * 설치 명령어 반환
 */
function getInstallCommand(pm) {
  switch (pm) {
    case 'yarn': return 'yarn install';
    case 'pnpm': return 'pnpm install';
    default: return 'npm install';
  }
}

// ============================================================================
// 메인 함수
// ============================================================================

/**
 * Step 6 환경 변수 & 의존성 가이드 실행
 */
async function runEnvAndDependencyGuide(projectRoot) {
  console.log(chalk.blue.bold('\n🚀 Step 6: 환경 변수 설정 & 의존성 갱신 가이드'));
  console.log(chalk.gray('=================================================='));

  // 1. 환경 변수 마이그레이션 가이드
  await guideEnvMigration(projectRoot);

  // 2. 의존성 갱신 가이드
  await guideDependencyReset(projectRoot);

  console.log(chalk.green.bold('\n✅ Step 6 가이드 출력 완료!'));
  console.log(chalk.yellow('   위 안내에 따라 환경 변수 파일과 의존성을 업데이트하세요.'));
}

// ============================================================================
// 모듈 내보내기
// ============================================================================

module.exports = {
  runEnvAndDependencyGuide,
  guideEnvMigration,
  guideDependencyReset,
  findEnvFiles,
  findViteEnvVariables,
};
