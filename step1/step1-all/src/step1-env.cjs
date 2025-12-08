const fs = require('fs-extra');
const path = require('path');
const ora = require('ora');
const chalk = require('chalk');

const CWD = process.cwd();

/**
 * Step 1 메인 함수
 * 구조 변경 없이 설정 파일(Config)과 의존성(Dependencies)만 교체한다.
 */
async function runStep1() {
  const spinner = ora('프로젝트 환경 설정을 변경 중...').start();

  try {
    // 1. package.json 수정 (Vite -> Next)
    spinner.text = 'package.json 의존성 및 스크립트 수정 중...';
    await updatePackageJson();
  } catch (error) {
    spinner.fail('package.json 의존성 및 스크립트 수정 중 에러 발생');
    console.error(error);
    throw error;
  }

  try {
    // 1. package.json 수정 (Vite -> Next)
    spinner.text = 'package.json 의존성 및 스크립트 수정 중...';
    await updatePackageJson();

    // 2. 설정 파일 교체 (vite.config 삭제, next.config 생성)
    spinner.text = 'Vite 설정을 제거하고 Next.js 설정을 생성 중...';
    await setupConfigFiles();

    // 3. TypeScript 설정 정리 (vite 타입 제거)
    spinner.text = 'tsconfig.json에서 Vite 관련 설정 제거 중...';
    await updateTsConfig();

    spinner.succeed('환경 설정 변경 완료 (코드 및 폴더 구조는 변경되지 않음)');
  } catch (error) {
    spinner.fail('Step 1 실패');
    console.error(error);
    throw error;
  }
}
// ====================================================
// 1. package.json 파일 내부 수정하여 빌드 도구를 교체한다.
// ====================================================
async function updatePackageJson() {
  const pkgPath = path.join(CWD, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error('package.json을 찾을 수 없습니다.');

  const pkg = await fs.readJson(pkgPath);

  // Vite 관련 의존성 제거(devDependencies 삭제)
  if (pkg.devDependencies) {
    delete pkg.devDependencies['vite'];
    delete pkg.devDependencies['@vitejs/plugin-react'];
    delete pkg.devDependencies['@vitejs/plugin-react-swc'];
    delete pkg.devDependencies['@vitejs/plugin-svelte'];
  }

  // Next.js 의존성 추가 (dependencies 추가)
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['next'] = 'latest';
  // react, react-dom은 기존 버전 유지

  // 스크립트 전면 교체 (scripts 명령어 변경)
  pkg.scripts = {
    ...pkg.scripts,
    dev: 'next dev',
    build: 'next build',
    start: 'next start',
    lint: 'next lint', // eslint -> next lint
  };
  // 스크립트에 Vite 전용 'preview' 스크립트 제거
  if (pkg.scripts['preview']) {
    delete pkg.scripts['preview'];
  }

  await fs.writeJson(pkgPath, pkg, { spaces: 2 });
}

// =================================================================================
// 2. Vite 관련 설정 파일을 물리적으로 삭제하고, Next.js 구동에 필요한 기본 파일을 생성한다.
// =================================================================================
async function setupConfigFiles() {
  // 삭제할 Vite 관련 파일들
  const filesToRemove = [
    'vite.config.js', // JS 프로젝트용 설정
    'vite.config.ts', // TS 프로젝트용 설정
    'vite.config.mjs', // ESM 프로젝트용 설정
    'vite.config.cjs', // CJS 프로젝트용 설정 (혹시 모를 대비)
    'tsconfig.node.json', // Vite용 TS 설정
    'vite-env.d.ts', // Vite 타입 정의 (표준)
    'vite-env.d.mts', // TS 타입 정의 (최신 ESM)
  ];

  for (const file of filesToRemove) {
    const filePath = path.join(CWD, file);
    if (fs.existsSync(filePath)) await fs.remove(filePath);
  }

  // src 폴더 내의 vite-env 삭제
  const srcFilesToDelete = [path.join(CWD, 'src', 'vite-env.d.ts'), path.join(CWD, 'src', 'vite-env.d.mts')];
  for (const file of srcFilesToDelete) {
    if (fs.existsSync(file)) await fs.remove(file);
  }

  // Next.js 전역 설정 파일 생성 (next.config.mjs 생성)
  const nextConfigContent = `/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`;
  await fs.writeFile(path.join(CWD, 'next.config.mjs'), nextConfigContent);

  // .gitignore 업데이트
  const gitignorePath = path.join(CWD, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    let content = await fs.readFile(gitignorePath, 'utf-8');

    const itemsToAdd = ['.next', 'next-env.d.ts', 'dist'];
    const newItems = itemsToAdd.filter((item) => !content.includes(item));

    if (newItems.length > 0) {
      // 파일 끝에 개행이 없으면 개행 추가 후 내용 붙이기
      const prefix = content.endsWith('\n') ? '' : '\n';
      content += `${prefix}\n# Next.js\n${newItems.join('\n')}\n`;

      await fs.writeFile(gitignorePath, content);
    }
  }
}

// =================================================================================================
// 3. TypeScript 컴파일러 설정(tsconfig.node.json, tsconfig.app.json) 정리 및 tsconfig.json 재구성한다.
// =================================================================================================
// [헬퍼 함수] 주석이 있는 JSON도 안전하게 읽어주는 함수
async function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    // 정규식으로 주석(//... 또는 /*...*/) 제거 후 파싱
    const cleanJson = content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(cleanJson);
  } catch (e) {
    return null;
  }
}

async function updateTsConfig() {
  const tsConfigPath = path.join(CWD, 'tsconfig.json');
  const tsConfigAppPath = path.join(CWD, 'tsconfig.app.json');

  if (!fs.existsSync(tsConfigPath)) return;

  try {
    // 1. 안전하게 읽기 (주석 제거 파싱)
    const tsConfig = await readJsonSafe(tsConfigPath);
    if (!tsConfig) throw new Error('tsconfig.json 파싱 실패');

    // files, references 제거
    if (tsConfig.files) delete tsConfig.files;
    if (tsConfig.references) delete tsConfig.references;

    // 2. tsconfig.app.json에서 유지할 compilerOptions 수집
    let appConfig = {};
    if (fs.existsSync(tsConfigAppPath)) {
      appConfig = (await readJsonSafe(tsConfigAppPath)) || {};
    }

    const appCompiler = appConfig.compilerOptions || {};

    // 유지할 옵션만 선택
    const keepOptions = [
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
      'noFallthroughCasesInSwitch',
    ];

    const newCompilerOptions = {};

    // 유지 옵션 복사
    keepOptions.forEach((key) => {
      if (key in appCompiler) newCompilerOptions[key] = appCompiler[key];
    });

    // 3. 기존 tsconfig.json의 compilerOptions도 있다면 병합 (우선순위 고려)
    if (tsConfig.compilerOptions) {
      keepOptions.forEach((key) => {
        if (key in tsConfig.compilerOptions && !newCompilerOptions[key]) {
          newCompilerOptions[key] = tsConfig.compilerOptions[key];
        }
      });
    }

    // 생성 옵션 추가 (Next.js 필수)
    newCompilerOptions.allowJs = true;
    newCompilerOptions.resolveJsonModule = true;
    newCompilerOptions.isolatedModules = true;
    newCompilerOptions.forceConsistentCasingInFileNames = true;
    newCompilerOptions.esModuleInterop = true;
    newCompilerOptions.incremental = true; // Next.js 권장

    // include / exclude Next.js 생성
    tsConfig.compilerOptions = newCompilerOptions;
    tsConfig.include = ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'];
    tsConfig.exclude = ['node_modules'];

    // 4. tsconfig.app.json 삭제 (병합 완료했으므로)
    if (fs.existsSync(tsConfigAppPath)) {
      await fs.remove(tsConfigAppPath);
    }

    // tsconfig.json 다시 기록
    await fs.writeJson(tsConfigPath, tsConfig, { spaces: 2 });
  } catch (e) {
    console.warn(chalk.yellow(`⚠️  tsconfig.json 수정 건너뜀: ${e.message}`));
  }
}

module.exports = {
  runStep1,
};
