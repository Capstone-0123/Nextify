#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const { runStep1 } = require('./src/step1-env.cjs');
const {
  detectPackageManager,
  detectLanguage,
  detectBuildTool,
  detectMonorepo,
  detectAppType,
  getInstallCommand,
} = require('./src/utils/project-info.cjs');

const program = new Command();

program.name('migrate-next').description('React(Vite) 프로젝트를 Next.js로 마이그레이션하는 CLI').version('0.1.0');

program
  .command('step1')
  .description('1단계: 초기 환경 설정 (패키지, 설정파일)')
  .action(async () => {
    console.log(chalk.blue.bold('🚀 Next.js 마이그레이션 Step 1을 시작합니다...'));

    const cwd = process.cwd();

    // ---------------------------------------------------------
    // 1. 프로젝트 상태 감지 (Analysis)
    // ---------------------------------------------------------
    const pm = detectPackageManager(cwd);
    const lang = detectLanguage(cwd);
    const buildTool = detectBuildTool(cwd);
    const monorepo = detectMonorepo(cwd);
    const appType = detectAppType(cwd);

    // 정보 출력
    console.log(chalk.gray(`📦 패키지 매니저: ${chalk.cyan(pm)}`));
    console.log(chalk.gray(`📘 프로젝트 언어: ${chalk.cyan(lang === 'ts' ? 'TypeScript' : 'JavaScript')}`));
    console.log(chalk.gray(`🛠️  빌드 도구:     ${chalk.cyan(buildTool.toUpperCase())}`));

    if (monorepo) {
      console.log(chalk.magenta(`🏢 모노레포 감지: ${chalk.bold(monorepo)}`));
    }
    console.log(chalk.gray('--------------------------------------------------'));

    // ---------------------------------------------------------
    // 2. 가드 (Guard Clauses) - 실행 조건 검증
    // ---------------------------------------------------------

    // Check 1: Vite 프로젝트인가?
    if (buildTool !== 'vite') {
      console.error(chalk.red.bold('\n⛔️ 지원하지 않는 프로젝트 형식입니다.'));
      if (buildTool === 'cra') {
        console.error(chalk.yellow('👉 현재 이 도구는 Vite 기반 프로젝트만 지원합니다. (CRA 감지됨)'));
      } else {
        console.error(chalk.yellow('👉 package.json에서 "vite" 의존성을 찾을 수 없습니다.'));
      }
      process.exit(1);
    }

    // Check 2: SPA(App) 루트인가? (index.html 유무)
    if (appType !== 'spa') {
      console.error(chalk.red.bold('\n⛔️ 마이그레이션 대상을 찾을 수 없습니다. (index.html 없음)'));

      if (monorepo && appType === 'library-or-server') {
        console.error(
          chalk.yellow('👉 모노레포 루트가 아닌, 실제 앱이 있는 workspace 폴더(예: apps/web)로 이동하여 실행해주세요.')
        );
      } else {
        console.error(chalk.yellow('👉 이 도구는 React 애플리케이션(SPA)을 대상으로 합니다.'));
        console.error(chalk.gray('   (라이브러리 패키지나 index.html이 없는 프로젝트는 지원하지 않습니다)'));
      }
      process.exit(1);
    }

    // ---------------------------------------------------------
    // 3. 실행 (Execution)
    // ---------------------------------------------------------
    try {
      await runStep1();

      const installCmd = getInstallCommand(pm);

      console.log(chalk.green.bold('\n✅ Step 1 완료!'));

      if (monorepo) {
        console.log(chalk.yellow(`\n⚠️  모노레포 환경입니다.`));
        console.log(chalk.gray(`   의존성 설치 시 호이스팅(hoisting) 문제가 발생할 수 있으니 주의해주세요.`));
      }

      console.log(chalk.yellow(`👉 터미널에 ${chalk.bold(installCmd)}를 입력하여 변경된 의존성을 설치해주세요.`));
    } catch (error) {
      console.error(chalk.red('\n❌ 마이그레이션 중 오류 발생:'), error);
      process.exit(1);
    }
  });

program.parse(process.argv);
