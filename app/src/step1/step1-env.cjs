// src/step1/step1-env.cjs

const fs = require('fs-extra');
const path = require('path');
const ora = require('ora');
const chalk = require('chalk');

// [중요] 기존의 const CWD = process.cwd(); 는 삭제하거나 주석 처리합니다.
// 함수들이 이제 인자로 경로를 받아서 처리하기 때문입니다.

/**
 * Step 1 메인 함수
 * targetDir를 인자로 받도록 수정 (기본값: 현재 실행 위치)
 */
async function runStep1(targetDir = process.cwd()) {
  const spinner = ora().start();

  try {
    // 1. package.json 수정
    spinner.text = 'package.json 의존성 및 스크립트 수정 중...';
    // [중요] targetDir를 인자로 전달
    await updatePackageJson(targetDir);
    spinner.succeed('package.json 의존성 및 스크립트 수정 완료');

    // 2. 설정 파일 교체
    spinner.start('Vite 설정을 제거하고 Next.js 설정을 생성 중...');
    // [중요] targetDir를 인자로 전달
    await setupConfigFiles(targetDir);
    spinner.succeed('설정 파일 교체 완료 (vite.config 삭제, next.config 생성)');

    // 3. TypeScript 설정 정리
    spinner.start('tsconfig.json에서 Vite 관련 설정 제거 중...');
    // [중요] targetDir를 인자로 전달
    await updateTsConfig(targetDir);
    spinner.succeed('tsconfig.json 설정 정리 완료');
  } catch (error) {
    spinner.fail('Step 1 실패');
    console.error(error);
    throw error;
  }
}

// ====================================================
// 1. package.json 수정 (cwd 인자 추가)
// ====================================================
async function updatePackageJson(cwd) {
  // [중요] CWD 대신 인자로 받은 cwd 사용
  const pkgPath = path.join(cwd, 'package.json');

  if (!fs.existsSync(pkgPath)) throw new Error('package.json을 찾을 수 없습니다.');
  const pkg = await fs.readJson(pkgPath);

  // Vite 관련 의존성 제거
  if (pkg.devDependencies) {
    delete pkg.devDependencies['vite'];
    delete pkg.devDependencies['@vitejs/plugin-react'];
    delete pkg.devDependencies['@vitejs/plugin-react-swc'];
    delete pkg.devDependencies['@vitejs/plugin-svelte'];
  }

  // Next.js 의존성 추가
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['next'] = 'latest';

  // 스크립트 교체
  pkg.scripts = {
    ...pkg.scripts,
    dev: 'next dev',
    build: 'next build',
    start: 'next start',
    lint: 'next lint',
  };

  if (pkg.scripts['preview']) {
    delete pkg.scripts['preview'];
  }

  await fs.writeJson(pkgPath, pkg, { spaces: 2 });
}

// =================================================================================
// 2. 설정 파일 교체 (cwd 인자 추가)
// =================================================================================
async function setupConfigFiles(cwd) {
  const filesToRemove = [
    'vite.config.js',
    'vite.config.ts',
    'vite.config.mjs',
    'vite.config.cjs',
    'tsconfig.node.json',
    'vite-env.d.ts',
    'vite-env.d.mts',
  ];

  // [중요] CWD 대신 인자로 받은 cwd 사용
  for (const file of filesToRemove) {
    const filePath = path.join(cwd, file);
    if (fs.existsSync(filePath)) await fs.remove(filePath);
  }

  const srcFilesToDelete = [path.join(cwd, 'src', 'vite-env.d.ts'), path.join(cwd, 'src', 'vite-env.d.mts')];
  for (const file of srcFilesToDelete) {
    if (fs.existsSync(file)) await fs.remove(file);
  }

  const nextConfigContent = `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`;
  await fs.writeFile(path.join(cwd, 'next.config.mjs'), nextConfigContent);

  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    let content = await fs.readFile(gitignorePath, 'utf-8');
    const itemsToAdd = ['.next', 'next-env.d.ts', 'dist'];
    const newItems = itemsToAdd.filter((item) => !content.includes(item));

    if (newItems.length > 0) {
      const prefix = content.endsWith('\n') ? '' : '\n';
      content += `${prefix}\n# Next.js\n${newItems.join('\n')}\n`;
      await fs.writeFile(gitignorePath, content);
    }
  }
}

// =================================================================================================
// 3. TypeScript 설정 정리 (cwd 인자 추가)
// =================================================================================================
async function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const cleanJson = content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(cleanJson);
  } catch (e) {
    return null;
  }
}

async function updateTsConfig(cwd) {
  // [중요] CWD 대신 인자로 받은 cwd 사용
  const tsConfigPath = path.join(cwd, 'tsconfig.json');
  const tsConfigAppPath = path.join(cwd, 'tsconfig.app.json');

  if (!fs.existsSync(tsConfigPath)) return;

  try {
    const tsConfig = await readJsonSafe(tsConfigPath);
    if (!tsConfig) throw new Error('tsconfig.json 파싱 실패');

    if (tsConfig.files) delete tsConfig.files;
    if (tsConfig.references) delete tsConfig.references;

    let appConfig = {};
    if (fs.existsSync(tsConfigAppPath)) {
      appConfig = (await readJsonSafe(tsConfigAppPath)) || {};
    }

    const appCompiler = appConfig.compilerOptions || {};
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

    keepOptions.forEach((key) => {
      if (key in appCompiler) newCompilerOptions[key] = appCompiler[key];
    });

    if (tsConfig.compilerOptions) {
      keepOptions.forEach((key) => {
        if (key in tsConfig.compilerOptions && !newCompilerOptions[key]) {
          newCompilerOptions[key] = tsConfig.compilerOptions[key];
        }
      });
    }

    newCompilerOptions.allowJs = true;
    newCompilerOptions.resolveJsonModule = true;
    newCompilerOptions.isolatedModules = true;
    newCompilerOptions.forceConsistentCasingInFileNames = true;
    newCompilerOptions.esModuleInterop = true;
    newCompilerOptions.incremental = true;

    tsConfig.compilerOptions = newCompilerOptions;
    tsConfig.include = ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'];
    tsConfig.exclude = ['node_modules'];

    if (fs.existsSync(tsConfigAppPath)) {
      await fs.remove(tsConfigAppPath);
    }

    await fs.writeJson(tsConfigPath, tsConfig, { spaces: 2 });
  } catch (e) {
    console.warn(chalk.yellow(`⚠️  tsconfig.json 수정 건너뜀: ${e.message}`));
  }
}

module.exports = {
  runStep1,
};
