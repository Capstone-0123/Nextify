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
const inquirer = require('inquirer');
const { backupFiles, rollbackFiles, clearBackup } = require('./src/utils/backup.cjs'); // 추가
const path = require('path');
const { cloneProject } = require('./src/utils/copy.cjs');

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
      // [1] 마이그레이션 방식 선택 (복제 vs 원본적용)
      const { mode } = await inquirer.prompt([
        {
          type: 'list', // 화살표 키로 선택하는 UI
          name: 'mode',
          message: '마이그레이션을 어떻게 진행하시겠습니까?',
          choices: [
            { name: '새 폴더에 복사본을 만들어서 진행 (추천, 원본 보존)', value: 'copy' },
            { name: '현재 폴더에 바로 적용 (주의: 원본 변경됨)', value: 'inplace' },
          ],
        },
      ]);

      let targetPath = cwd; // 기본 타겟은 현재 폴더

      // [2] '복사본 만들기' 선택 시 로직
      if (mode === 'copy') {
        const parentDir = path.dirname(cwd);
        const currentDirName = path.basename(cwd);
        const defaultNewName = `${currentDirName}-nextified`; // 기본 이름 제안

        // 새 폴더 이름 입력받기
        const { newFolderName } = await inquirer.prompt([
          {
            type: 'input',
            name: 'newFolderName',
            message: '생성할 새 프로젝트 폴더 이름:',
            default: defaultNewName,
          },
        ]);

        targetPath = path.join(parentDir, newFolderName);

        // 프로젝트 복제 실행 (node_modules 제외)
        // (src/utils/copy.cjs의 cloneProject 함수 사용)
        await cloneProject(cwd, targetPath);

        console.log(chalk.blue(`\n📂 작업 경로가 변경되었습니다: ${targetPath}`));
      }

      // [3] 마이그레이션 실행
      // 선택된 경로(targetPath)를 runStep1에 전달하여 그 안에서 작업 수행
      await runStep1(targetPath);

      // [4] 완료 메시지 및 안내
      const installCmd = getInstallCommand(pm); // 감지된 패키지 매니저(npm, yarn 등) 명령어

      console.log(chalk.green.bold('\n✅ Step 1 완료!'));

      if (mode === 'copy') {
        // 복제본인 경우: 이동해서 설치하라는 안내가 필수
        console.log(chalk.yellow(`\n👉 중요: 복제된 폴더에는 node_modules가 없습니다.`));
        console.log(chalk.yellow(`   1. cd ${path.basename(targetPath)}`)); // 사용자가 알아보기 쉽게 폴더명만 출력
        console.log(chalk.yellow(`   2. ${installCmd} (의존성 재설치 필수)`));
        console.log(chalk.yellow(`   3. npm run dev (실행)`));
      } else {
        // 원본 적용인 경우
        if (monorepo) {
          console.log(chalk.yellow(`\n⚠️  모노레포 환경입니다. 호이스팅 주의가 필요합니다.`));
        }
        console.log(chalk.yellow(`👉 터미널에 ${chalk.bold(installCmd)}를 입력하여 변경된 의존성을 설치해주세요.`));
      }
    } catch (error) {
      console.error(chalk.red('\n❌ 마이그레이션 중 오류 발생:'), error);
      process.exit(1);
    }
  });

program.parse(process.argv);
