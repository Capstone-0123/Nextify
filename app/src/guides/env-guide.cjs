// src/guides/env-guide.cjs
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
  const envFiles = await findEnvFiles(projectRoot);
  const viteEnvVars = await findViteEnvVariables(projectRoot);

  console.log(chalk.white('\n마이그레이션 후 확인할 항목'));
  console.log(chalk.white('\n환경 변수 확인'));

  // ① 파일명 변경 안내
  console.log(chalk.white('  ① 환경 변수 파일명 확인'));
  if (envFiles.length > 0) {
    console.log(chalk.gray('    발견된 파일:'));
    envFiles.forEach((file) => {
      console.log(chalk.gray(`      - ${path.relative(projectRoot, file)}`));
    });
    console.log(chalk.white('    Next.js는 .env.local을 기본 환경 변수 파일로 사용합니다.'));
    const renameTargets = envFiles
      .map((f) => path.basename(f))
      .filter((name) => name === '.env' || name === '.env.development' || name === '.env.production');
    if (renameTargets.length > 0) {
      console.log(chalk.white('    필요하면 아래 명령어로 파일명을 변경하세요:'));
      renameTargets.forEach((name) => {
        const target = name === '.env' ? '.env.local' : `${name}.local`;
        console.log(chalk.gray(`      mv ${name} ${target}`));
      });
    }
  } else {
    console.log(chalk.gray('    .env 파일이 없습니다. 필요하면 .env.local 파일을 직접 만드세요.'));
  }

  // ② .gitignore 보안 설정
  console.log(chalk.white('  ② .gitignore 보안 설정'));
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const hasGitignore = fs.existsSync(gitignorePath);

  if (hasGitignore) {
    const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
    const hasEnvLocal =
      gitignoreContent.includes('.env.local') || gitignoreContent.includes('.env*.local');
    if (hasEnvLocal) {
      console.log(chalk.green('    ✔ .gitignore에 .env.local이 이미 포함되어 있습니다.'));
    } else {
      console.log(chalk.white('    필요하면 .env.local이 Git에 올라가지 않도록 .gitignore에 추가하세요:'));
      console.log(chalk.gray('      .env.local'));
      console.log(chalk.gray('      .env*.local'));
    }
  } else {
    console.log(chalk.white('    필요하면 .gitignore 파일을 만들고 아래 내용을 추가하세요:'));
    console.log(chalk.gray('      .env.local'));
    console.log(chalk.gray('      .env*.local'));
  }

  // ③ 환경 변수 접두어 변경
  console.log(chalk.white('  ③ 환경 변수 접두어 변경 (VITE_ → NEXT_PUBLIC_)'));
  if (viteEnvVars.length > 0) {
    console.log(chalk.white('    소스 코드는 이미 자동으로 변환되었습니다.'));
    const allVars = Array.from(new Set(viteEnvVars.flatMap((r) => r.variables)));
    if (allVars.length > 0) {
      const example = allVars[0];
      const exampleNew = example.replace('VITE_', 'NEXT_PUBLIC_');
      console.log(
        chalk.white(`    .env.local에서 변수 이름만 바꿔주세요. ex) ${example} → ${exampleNew}`),
      );
    } else {
      console.log(chalk.white('    .env.local에서 변수 이름의 VITE_ 접두어를 NEXT_PUBLIC_ 로 바꿔주세요.'));
    }
  } else {
    console.log(chalk.gray('    VITE_ 접두어 변수가 발견되지 않았습니다.'));
  }
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
      const envViteVars = results.flatMap((r) => r.variables);
      const uniqueSourceVars = sourceViteVars.filter((v) => !envViteVars.includes(v));

      if (uniqueSourceVars.length > 0) {
        results.push({
          file: path.join(projectRoot, 'src/**/*.{ts,tsx,js,jsx}'),
          variables: uniqueSourceVars,
        });
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
  const pm = detectPackageManager(projectRoot);
  const lockFile = getLockFileName(pm);
  const installCmd = getInstallCommand(pm);

  console.log(chalk.white('\n의존성 재설치'));
  console.log(chalk.white('  아래 순서대로 의존성을 다시 설치하세요.'));

  // ① 기존 모듈 제거
  console.log(chalk.white('  ① 기존 node_modules 삭제'));
  console.log(chalk.gray('    Vite 환경의 패키지가 남아 있어 충돌할 수 있습니다. 먼저 삭제하세요.'));
  console.log(chalk.gray(`    · macOS / Linux:  rm -rf node_modules ${lockFile}`));
  console.log(chalk.gray(`    · Windows (PowerShell):  Remove-Item -Recurse -Force node_modules, ${lockFile}`));

  // ② 재설치
  console.log(chalk.white('  ② 패키지 재설치'));
  console.log(chalk.gray(`    ${installCmd}`));

  // ③ 캐시 정리 (선택)
  console.log(chalk.white('  ③ 캐시 정리 (설치 중 문제가 생길 경우)'));
  if (pm === 'npm') {
    console.log(chalk.gray('    npm cache clean --force'));
  } else if (pm === 'yarn') {
    console.log(chalk.gray('    yarn cache clean'));
  } else if (pm === 'pnpm') {
    console.log(chalk.gray('    pnpm store prune'));
  }
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
    case 'yarn':
      return 'yarn.lock';
    case 'pnpm':
      return 'pnpm-lock.yaml';
    default:
      return 'package-lock.json';
  }
}

/**
 * 설치 명령어 반환
 */
function getInstallCommand(pm) {
  switch (pm) {
    case 'yarn':
      return 'yarn install';
    case 'pnpm':
      return 'pnpm install';
    default:
      return 'npm install';
  }
}

// ============================================================================
// 메인 함수
// ============================================================================

/**
 * Step 6 환경 변수 & 의존성 가이드 실행
 *
 * @param {string} projectRoot
 * @param {{ reportPath?: string }} [options]
 */
async function runEnvAndDependencyGuide(projectRoot, options = {}) {
  await guideEnvMigration(projectRoot);
  if (options.showDependencyReset === true) {
    await guideDependencyReset(projectRoot);
  }

  if (options.reportPath) {
    console.log(chalk.gray(`※ 성능 레포트: ${options.reportPath}`));
  }
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
