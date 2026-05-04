#!/usr/bin/env node
// .env.local 파일 로드 (가장 먼저 실행)
require('dotenv').config({ path: require('path').join(__dirname, '.env.local') });

// =========================================================
// Node.js 버전 사전 체크 (가장 먼저, 다른 require보다 앞)
//  - Lighthouse v12가 Node 18.18+ 를 요구하고, ts-morph 등 일부 의존성도 최신 Node에서 안정.
//  - 미달 시 step1을 시작하기 전에 즉시 종료해서 팀원들이 시간을 낭비하지 않게 합니다.
//  - 권장 LTS 22.x. 의존성 미설치 등 다른 에러로 메시지가 가려지지 않도록 가장 먼저 검사합니다.
// =========================================================
(function ensureNodeVersion() {
  const REQUIRED_MAJOR = 18;
  const REQUIRED_MINOR = 18;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.version || '');
  if (!match) return; // 알 수 없으면 통과
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const tooOld =
    major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR);
  if (!tooOld) return;

  // chalk가 아직 require되지 않았을 수 있으니 ANSI escape를 직접 사용 (의존성 무관 안전)
  const RED = '\x1b[31m';
  const YELLOW = '\x1b[33m';
  const CYAN = '\x1b[36m';
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';

  const lines = [
    '',
    `${RED}${BOLD}❌ Node.js 버전이 너무 낮습니다.${RESET}`,
    `${YELLOW}현재 Node 버전: ${process.version}${RESET}`,
    `${YELLOW}필요 최소 버전: v${REQUIRED_MAJOR}.${REQUIRED_MINOR}.0 (권장: LTS 22.x)${RESET}`,
    '',
    'Nextify는 Lighthouse(v12) 기반 성능 측정과 최신 ESM 모듈에 의존하므로',
    `Node.js v${REQUIRED_MAJOR}.${REQUIRED_MINOR} 이상이 필요합니다.`,
    '',
    `${CYAN}업그레이드 방법:${RESET}`,
  ];

  if (process.platform === 'win32') {
    lines.push('  - winget:  winget install OpenJS.NodeJS.LTS');
    lines.push('  - 직접 다운로드: https://nodejs.org/ko/download');
    lines.push('  - nvm-windows: https://github.com/coreybutler/nvm-windows/releases');
    lines.push('      예) nvm install lts && nvm use lts');
  } else if (process.platform === 'darwin') {
    lines.push('  - Homebrew: brew install node@22');
    lines.push('  - nvm:      nvm install --lts && nvm use --lts');
  } else {
    lines.push('  - nvm:           nvm install --lts && nvm use --lts');
    lines.push('  - NodeSource:    https://github.com/nodesource/distributions');
  }

  lines.push('');
  lines.push(`${YELLOW}업그레이드 후 ${BOLD}node -v${RESET}${YELLOW}로 버전을 확인하고 다시 실행하세요.${RESET}`);
  lines.push('');

  console.error(lines.join('\n'));
  process.exit(1);
})();

const { Command } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const path = require('path');

// 모듈 경로 변경 (step 폴더의 index.cjs )
const { runStep1 } = require('./src/step1/index.cjs');
const { runStep2 } = require('./src/step2/index.cjs');
const { runStep3 } = require('./src/step3/index.cjs');
const { runStep4 } = require('./src/step4/index.cjs');
const { runStep5 } = require('./src/step5/index.cjs');
const { runStep6 } = require('./src/step6/index.cjs');
const { runStep7 } = require('./src/step7/index.cjs');

const {
  detectPackageManager,
  detectLanguage,
  detectBuildTool,
  detectMonorepo,
  detectAppType,
  getInstallCommand,
} = require('./src/utils/project-info.cjs');
const { cloneProject } = require('./src/utils/copy.cjs');
const {
  REVIEW_ROOT_DIR,
  createStepReviewSession,
  createSnapshotReviewSession,
  openReviewDiff,
  getReviewExtensionStatus,
  focusReviewPanel,
  installReviewExtension,
  REVIEW_EXTENSION_MARKET_ID,
} = require('./src/utils/review-session.cjs');
const { generateText, createMigrationPrompt, generateTextStream } = require('./src/utils/gemini-client.cjs');
const { runAskApply } = require('./src/utils/ai-file-apply.cjs');
const { runAiReviewSessionStream } = require('./src/utils/ai-review-session.cjs');
const { ensureGeminiCliReady } = require('./src/utils/gemini-cli-setup.cjs');
const { printRelPathsBlock } = require('./src/utils/path-list-print.cjs');
const { generatePerformanceReport } = require('./src/step7/performance-report.cjs');
const fs = require('fs-extra');
const pkg = require('./package.json');

async function ensureReviewExtensionReady() {
  const status = getReviewExtensionStatus();
  if (status.editorAvailable && status.installed) {
    return { installed: true, status };
  }

  if (!status.editorAvailable) {
    console.log(chalk.yellow('VS Code/Cursor 명령(`code` 또는 `cursor`)을 찾지 못했습니다.'));
    console.log(chalk.white('   - 에디터를 설치한 뒤 아래에서 확장을 설치하세요:'));
    console.log(chalk.white(`     https://marketplace.visualstudio.com/items?itemName=${REVIEW_EXTENSION_MARKET_ID}`));
    return { installed: false, status };
  }

  const assumeYes = process.env.NEXTIFY_ASSUME_YES === '1';
  let doInstall = assumeYes;
  if (!assumeYes) {
    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'doInstall',
        default: true,
        message: 'Nextify Review 확장이 설치되어 있지 않습니다. 지금 설치할까요?',
      },
    ]);
    doInstall = answer.doInstall;
  }

  if (!doInstall) {
    console.log(chalk.white(`   - 수동: code --install-extension ${REVIEW_EXTENSION_MARKET_ID}`));
    console.log(chalk.white(`   - 또는: https://marketplace.visualstudio.com/items?itemName=${REVIEW_EXTENSION_MARKET_ID}`));
    return { installed: false, status };
  }

  const result = installReviewExtension(status.command);
  if (!result.installed) {
    console.log(chalk.yellow('자동 설치에 실패했습니다. 수동 설치 후 다시 시도하세요.'));
    console.log(chalk.white(`   - 수동: ${status.command} --install-extension ${REVIEW_EXTENSION_MARKET_ID}`));
    return { installed: false, status };
  }

  const newStatus = getReviewExtensionStatus();
  if (newStatus.installed && newStatus.command) {
    return { installed: true, status: newStatus };
  }
  // 설치 직후 `--list-extensions` 가 아직 갱신되지 않은 경우에도 포커스 시도용
  return { installed: true, status: { editorAvailable: true, installed: true, command: status.command } };
}

const program = new Command();

program.name('migrate-next').description('React(Vite) 프로젝트를 Next.js로 마이그레이션하는 CLI').version(pkg.version);

program.addHelpText(
  'after',
  `\n예시:\n` +
    `  migrate-next\n` +
    `    - step1~step7을 순차 실행한 뒤, 최종 diff + Gemini CLI 대화형 리뷰(수정 불가) + 성능 레포트를 한 번에 진행합니다.\n` +
    `  migrate-next steps\n` +
    `    - step1~step7만 순차 실행합니다. (성능 레포트/AI 리뷰 제외)\n` +
    `    - 리뷰 시작 전 Gemini CLI(\`gemini\`) 설치 여부를 확인하고, 없으면 자동 설치를 시도합니다.\n` +
    `    - Ctrl+C는 현재 AI 리뷰만 중단합니다.\n` +
    `    - Nextify Review 패널에서 최종 diff를 확인하고, 성능 레포트(nextify-performance-report.md)까지 생성됩니다.\n` +
    `\n레거시(기존 step1 preview clone 방식):\n` +
    `  migrate-next step1 --review\n`,
);

// =========================================================
// Command: Step 1
// =========================================================
program
  .command('step1')
  .description('1단계: 초기 환경 설정 (패키지, 설정파일)')
  .option('-o, --output <path>', '복사본을 생성할 경로 (지정 시 복사 모드로 자동 실행)')
  .option('--inplace', '원본 폴더에서 직접 마이그레이션 (복사 안 함)')
  .option('--review', '원본은 유지하고 .ai-migration diff 세션을 생성해 IDE에서 검토')
  .action(async (options) => {
    console.log(chalk.blue.bold('🚀 Next.js 마이그레이션 Step 1을 시작합니다...'));

    const cwd = process.cwd();

    // 1. 프로젝트 상태 감지
    const pm = detectPackageManager(cwd);
    const lang = detectLanguage(cwd);
    const buildTool = detectBuildTool(cwd);
    const monorepo = detectMonorepo(cwd);
    const appType = detectAppType(cwd);

    // 정보 출력
    console.log(chalk.gray(`📦 패키지 매니저: ${chalk.cyan(pm)}`));
    console.log(chalk.gray(`📘 프로젝트 언어: ${chalk.cyan(lang === 'ts' ? 'TypeScript' : 'JavaScript')}`));
    console.log(chalk.gray(`🛠️  빌드 도구:     ${chalk.cyan(buildTool.toUpperCase())}`));

    if (monorepo) console.log(chalk.magenta(`🏢 모노레포 감지: ${chalk.bold(monorepo)}`));
    console.log(chalk.gray('--------------------------------------------------'));

    // 2. 가드
    if (buildTool !== 'vite') {
      console.error(chalk.red.bold('\n⛔️ 지원하지 않는 프로젝트 형식입니다. (Vite 필수)'));
      process.exit(1);
    }
    if (appType !== 'spa') {
      console.error(chalk.red.bold('\n⛔️ SPA(index.html 보유) 프로젝트만 지원합니다.'));
      process.exit(1);
    }

    // 3. 실행
    try {
      let mode;
      let targetPath = cwd;

      // CLI 옵션으로 모드 결정
      if (options.review) {
        mode = 'review';
      } else if (options.output) {
        mode = 'copy';
        // 입력값 정리 (공백 제거)
        const cleanedPath = options.output.trim();

        // Windows 절대 경로 판단 (C:\, D:\ 등) 또는 Unix 절대 경로 (/)
        const isAbsolutePath = path.isAbsolute(cleanedPath) || /^[A-Za-z]:[\\/]/.test(cleanedPath);

        if (isAbsolutePath) {
          // 절대 경로면 그대로 사용
          targetPath = path.resolve(cleanedPath);
        } else if (cleanedPath.includes('/') || cleanedPath.includes('\\')) {
          // 상대 경로 (./foo, ../bar 등)면 현재 디렉토리 기준
          targetPath = path.resolve(cwd, cleanedPath);
        } else {
          // 폴더명만 입력한 경우 부모 디렉토리에 생성
          const parentDir = path.dirname(cwd);
          targetPath = path.join(parentDir, cleanedPath);
        }
      } else if (options.inplace) {
        mode = 'inplace';
      } else {
        // 옵션 없으면 대화형으로 선택
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'mode',
            message: '마이그레이션을 어떻게 진행하시겠습니까?',
            choices: [
              { name: '새 폴더에 복사본을 만들어서 진행 (추천)', value: 'copy' },
              { name: '현재 폴더에 바로 적용 (주의: 원본 변경)', value: 'inplace' },
            ],
          },
        ]);
        mode = answer.mode;
      }

      if (mode === 'copy' && !options.output) {
        const parentDir = path.dirname(cwd);
        const currentDirName = path.basename(cwd);
        const defaultNewPath = path.join(parentDir, `${currentDirName}-nextified`);

        const { outputPath } = await inquirer.prompt([
          {
            type: 'input',
            name: 'outputPath',
            message: '복사본을 생성할 경로 (폴더명 또는 전체 경로):',
            default: defaultNewPath,
          },
        ]);

        // 입력값 정리 (공백 제거)
        const cleanedPath = outputPath.trim();

        // Windows 절대 경로 판단 (C:\, D:\ 등) 또는 Unix 절대 경로 (/)
        const isAbsolutePath = path.isAbsolute(cleanedPath) || /^[A-Za-z]:[\\/]/.test(cleanedPath);

        if (isAbsolutePath) {
          // 절대 경로면 그대로 사용
          targetPath = path.resolve(cleanedPath);
        } else if (cleanedPath.includes('/') || cleanedPath.includes('\\')) {
          // 상대 경로 (./foo, ../bar 등)면 현재 디렉토리 기준
          targetPath = path.resolve(cwd, cleanedPath);
        } else {
          // 폴더명만 입력한 경우 부모 디렉토리에 생성
          targetPath = path.join(parentDir, cleanedPath);
        }
      }

      if (mode === 'copy') {
        await cloneProject(cwd, targetPath);
        process.chdir(targetPath);
        console.log(chalk.blue(`\n📂 작업 경로가 변경되었습니다: ${targetPath}`));
      }

      if (mode === 'review') {
        console.log(chalk.blue('\n리뷰 세션을 준비하는 중입니다...'));
        const reviewSession = await createStepReviewSession(cwd, 'step1', runStep1);

        if (reviewSession.manifest.changes.length === 0) {
          console.log(chalk.green('\n변경 사항이 없어 리뷰 세션을 만들지 않았습니다.'));
          return;
        }

        console.log(chalk.green(`\n✔ Step 1 preview 생성 완료 (${reviewSession.manifest.changes.length}개 변경)`));
        console.log(chalk.white(`리뷰 대상 변경 파일: ${reviewSession.manifest.changes.length}개`));
        const extReady = await ensureReviewExtensionReady();
        if (extReady.installed && extReady.status?.command) {
          focusReviewPanel(extReady.status);
        }
        const openResult = openFirstReviewableDiff(reviewSession.manifest);

        if (openResult.opened) {
          console.log(chalk.blue(`첫 번째 diff를 ${openResult.command}에서 열었습니다.`));
        } else {
          console.log(
            chalk.yellow(
              '자동으로 diff를 열지 못했습니다. Nextify Review 패널이나 session.json을 통해 수동으로 열어주세요.',
            ),
          );
        }

        console.log(chalk.yellow('\n⏸ Step 1은 리뷰 대기 상태에서 멈췄습니다.'));
        console.log(chalk.white('   - 왼쪽: 원본 파일'));
        console.log(chalk.white('   - 오른쪽: .ai-migration 안의 migrated 파일'));
        console.log(chalk.white('   - Cursor/VSCode의 Nextify Review 패널에서 Accept / Reject 하세요.'));
        console.log(chalk.white(`   - 세션 파일: ${reviewSession.manifestPath}`));
        return;
      }

      // Nextify 메타 저장 (baseline Vite 경로 기록)
      try {
        const metaDir = path.join(targetPath, '.nextify');
        const metaPath = path.join(metaDir, 'meta.json');
        await fs.ensureDir(metaDir);
        let sourceViteProjectRoot = mode === 'copy' ? cwd : null;

        // inplace라면 step1 적용 전에 Vite baseline 스냅샷 자동 생성
        // (step1이 package.json/scripts 등을 Next로 바꿔서 원본이 사라지기 때문)
        if (mode !== 'copy') {
          const resolvedTargetPath = path.resolve(targetPath);
          const parentDir = path.dirname(resolvedTargetPath);
          const projectName = path.basename(resolvedTargetPath);
          const baselineSnapshotRoot = path.join(parentDir, `${projectName}__nextify_snapshots`, 'vite-baseline');
          const exists = await fs.pathExists(baselineSnapshotRoot);
          if (!exists) {
            console.log(chalk.gray('\n[inplace] Vite baseline 스냅샷 생성 중...'));
            await cloneProject(targetPath, baselineSnapshotRoot);
            console.log(chalk.gray(`[inplace] Vite baseline 스냅샷 생성 완료: ${baselineSnapshotRoot}`));
          }
          sourceViteProjectRoot = baselineSnapshotRoot;
        }

        const meta = {
          createdAt: new Date().toISOString(),
          migrationRoot: targetPath,
          sourceViteProjectRoot,
          inplace: mode !== 'copy',
        };
        await fs.writeJson(metaPath, meta, { spaces: 2 });
      } catch (e) {
        console.log(chalk.yellow(`⚠️  .nextify/meta.json 저장 실패: ${e.message}`));
      }

      //  Step 1 실행
      await runStep1(targetPath);

      // 완료 안내
      const installCmd = getInstallCommand(pm);

      if (mode === 'copy') {
        // 현재 경로에서 target 경로로 가는 상대 경로 계산
        const relativePath = path.relative(cwd, targetPath);
        console.log(chalk.yellow(`\n👉 다음 단계:`));
        console.log(chalk.white(`   1. cd ${relativePath}`));
        console.log(chalk.white(`   2. ${installCmd} (의존성 설치)`));
        console.log(chalk.white(`   3. migrate-next step2`));
      } else {
        console.log(chalk.yellow(`👉 ${installCmd} 로 의존성을 설치한 후, 'migrate-next step2'를 실행하세요.`));
      }
    } catch (error) {
      console.error(chalk.red('\n❌ Step 1 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 2
// =========================================================
program
  .command('step2')
  .description('2단계: 라우팅 구조 변환 (React Router -> App Router)')
  .action(async () => {
    try {
      // Step 2 실행
      await runStep2(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 2 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 3
// =========================================================
program
  .command('step3')
  .description('3단계: 라우팅 페이지 변환 )')
  .action(async () => {
    try {
      // Step 3 실행
      await runStep3(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 3 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 4
// =========================================================
program
  .command('step4')
  .description('4단계: 스타일/리소스 마이그레이션')
  .action(async () => {
    try {
      // Step 4 실행
      await runStep4(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 4 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 5
// =========================================================
program
  .command('step5')
  .description('5단계: Zustand 상태 관리 마이그레이션')
  .action(async () => {
    try {
      // Step 5 실행
      await runStep5(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 5 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 6
// =========================================================
program
  .command('step6')
  .description('6단계: 환경 변수 설정 & 의존성 갱신 가이드')
  .action(async () => {
    try {
      // Step 6 실행
      await runStep6(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 6 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 7
// =========================================================
program
  .command('step7')
  .description('7단계: next/image, next/font, Dynamic Import 적용 및 React 흔적 정리')
  .option('--no-typecheck-autofix', '결정론적 TypeScript 자동 수정을 비활성화 (기본: 활성화, 토큰 비용 0)')
  .option('--no-typecheck-ai-fix', 'AI 기반 잔여 빌드 에러 보정을 비활성화 (기본: 활성화, GEMINI_API_KEY 필요)')
  .option(
    '--typecheck-ai-fix-budget <n>',
    'AI 보정 시 1회 세션에서 의뢰할 최대 파일 수 (기본 5)',
    (v) => Number(v),
  )
  .action(async (options) => {
    try {
      await runStep7(process.cwd(), {
        typecheckAutofix: options.typecheckAutofix,
        typecheckAiFix: options.typecheckAiFix,
        typecheckAiFixBudget: options.typecheckAiFixBudget,
      });
    } catch (error) {
      console.error(chalk.red('\n❌ Step 7 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Steps (step1~step7 only)
// =========================================================
program
  .command('steps')
  .description('step1~step7 순차 실행 (성능 레포트/AI 리뷰 제외)')
  .action(async () => {
    try {
      const projectRoot = process.cwd();
      const stepEntries = [
        ['step1', runStep1],
        ['step2', runStep2],
        ['step3', runStep3],
        ['step4', runStep4],
        ['step5', runStep5],
        ['step6', runStep6],
        ['step7', runStep7],
      ];

      for (const [stepName, stepRunner] of stepEntries) {
        const partNum = stepName.replace('step', '');
        console.log(chalk.yellow(`\n==================== Part ${partNum} (${stepName}) ====================`));
        await stepRunner(projectRoot);
      }

      console.log(chalk.green('\n✔ step1~step7 순차 실행 완료 (레포트/AI 리뷰 미실행).'));
      console.log(chalk.yellow('\n👉 필요 시 추가 실행'));
      console.log(chalk.white('   - 성능 레포트: migrate-next report'));
      console.log(chalk.white('   - 전체 오케스트레이터: migrate-next'));
    } catch (error) {
      console.error(chalk.red('\n❌ steps 실행 중 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Report (no migration)
// =========================================================
program
  .command('report')
  .description('성능 비교 레포트 생성 (레포트 명령으로 통합)')
  .option('--run-step7', '레포트 생성 전에 Step7 최적화를 먼저 적용')
  .option('--baseline <path>', 'Vite 원본 프로젝트 루트 경로 (메타가 없으면 필수)')
  .option('--output <path>', '생성할 마크다운 레포트 파일 경로 (기본: <projectRoot>/nextify-performance-report.md)')
  .option('--runs <number>', 'Lighthouse 측정 횟수 (기본 5)', (v) => Number(v), 5)
  .option('--warmup-runs <number>', 'Lighthouse 워밍업 횟수 (기본 1)', (v) => Number(v), 1)
  .action(async (options) => {
    try {
      const projectRoot = process.cwd();
      const outputPath = options.output ? path.resolve(options.output) : path.join(projectRoot, 'nextify-performance-report.md');
      const baselineViteRoot = options.baseline ? path.resolve(options.baseline) : undefined;
      const lighthouseRuns = Number.isFinite(options.runs) && options.runs > 0 ? Math.floor(options.runs) : 5;
      const warmupRuns =
        Number.isFinite(options.warmupRuns) && options.warmupRuns >= 0
          ? Math.floor(options.warmupRuns)
          : 1;

      if (options.runStep7) {
        await runStep7(projectRoot, {
          report: true,
          baselineViteRoot,
          outputPath,
          lighthouseRuns,
          warmupRuns,
        });
        return;
      }

      const { generatePerformanceReport } = require('./src/step7/performance-report.cjs');
      await generatePerformanceReport({
        projectRoot,
        baselineViteRoot,
        outputMarkdownPath: outputPath,
        lighthouseRuns,
        warmupRuns,
      });
    } catch (error) {
      console.error(chalk.red('\n❌ report 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Ask (Gemini AI)
// =========================================================
program
  .command('ask')
  .description('Gemini AI에게 React → Next.js 마이그레이션 관련 질문하기')
  .option('-q, --question <text>', '질문 내용 (옵션 없으면 대화형 입력)')
  .option('-s, --stream', '스트리밍 모드로 응답 받기 (실시간 출력)')
  .option('--apply', 'AI가 반환한 JSON 패치로 지정 파일만 디스크에 직접 적용 (검증용, 수정안 본문은 출력하지 않음)')
  .option('-f, --files <list>', '쉼표로 구분한 프로젝트 루트 기준 상대 경로 (--apply 시 필수)')
  .action(async (options) => {
    try {
      // API 키 확인
      if (!process.env.GEMINI_API_KEY) {
        console.error(chalk.red('\n❌ GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.'));
        console.log(chalk.yellow('\n설정 방법:'));
        console.log(chalk.white('  1. Google AI Studio에서 API 키 발급: https://makersuite.google.com/app/apikey'));
        console.log(chalk.white('  2. 환경 변수 설정:'));
        console.log(chalk.cyan('     Windows: set GEMINI_API_KEY=your_api_key'));
        console.log(chalk.cyan('     Mac/Linux: export GEMINI_API_KEY=your_api_key'));
        process.exit(1);
      }

      if (options.apply && options.stream) {
        console.error(chalk.red('\n❌ --apply 와 --stream 은 함께 쓸 수 없습니다.\n'));
        process.exit(1);
      }

      if (options.apply && !options.files) {
        console.error(chalk.red('\n❌ --apply 사용 시 -f/--files 로 수정 대상 파일을 지정해야 합니다.\n'));
        console.log(chalk.gray('예: migrate-next ask --apply -f src/App.tsx -q "..."\n'));
        process.exit(1);
      }

      // 질문 입력
      let question = options.question;
      if (!question) {
        const answer = await inquirer.prompt([
          {
            type: 'input',
            name: 'question',
            message: options.apply ? '파일에 반영할 지시를 입력하세요:' : '마이그레이션 관련 질문을 입력하세요:',
            validate: (input) => input.trim().length > 0 || '내용을 입력해주세요.',
          },
        ]);
        question = answer.question;
      }

      // 프로젝트 컨텍스트 수집
      const cwd = process.cwd();
      const context = {
        buildTool: detectBuildTool(cwd),
        language: detectLanguage(cwd),
        packageManager: detectPackageManager(cwd),
      };

      if (options.apply) {
        const spinner = require('ora')('AI가 코드를 적용하는 중...').start();
        const written = await runAskApply({
          projectRoot: cwd,
          question,
          filesCsv: options.files,
          context,
        });
        spinner.stop();
        printRelPathsBlock(chalk.green, '\n✅ 적용 완료', written);
        console.log('');
        return;
      }

      // 프롬프트 생성
      const prompt = createMigrationPrompt(question, context);

      console.log(chalk.blue.bold('\n🤖 Gemini AI가 답변을 생성하고 있습니다...\n'));

      if (options.stream) {
        // 스트리밍 모드
        await generateTextStream(prompt, (chunk) => {
          process.stdout.write(chalk.white(chunk));
        });
        console.log('\n');
      } else {
        // 일반 모드
        const spinner = require('ora')('답변 생성 중...').start();
        const response = await generateText(prompt);
        spinner.stop();
        console.log(chalk.green('\n📝 답변:\n'));
        console.log(chalk.white(response));
        console.log('\n');
      }
    } catch (error) {
      console.error(chalk.red('\n❌ 오류 발생:'), error.message);
      process.exit(1);
    }
  });

// =========================================================
// Command: Test Gemini Connection
// =========================================================
program
  .command('test-gemini')
  .description('Gemini API 연결 테스트')
  .action(async () => {
    try {
      const { generateText } = require('./src/utils/gemini-client.cjs');

      // API 키 확인
      if (!process.env.GEMINI_API_KEY) {
        console.error(chalk.red('\n❌ GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.'));
        console.log(chalk.yellow('\n설정 방법:'));
        console.log(chalk.white('  1. Google AI Studio에서 API 키 발급: https://makersuite.google.com/app/apikey'));
        console.log(chalk.white('  2. 환경 변수 설정:'));
        console.log(chalk.cyan('     Windows: set GEMINI_API_KEY=your_api_key'));
        console.log(chalk.cyan('     Mac/Linux: export GEMINI_API_KEY=your_api_key'));
        process.exit(1);
      }

      // 질문 입력
      const answer = await inquirer.prompt([
        {
          type: 'input',
          name: 'question',
          message: '마이그레이션 관련 질문을 입력하세요:',
          validate: (input) => input.trim().length > 0 || '질문을 입력해주세요.',
        },
      ]);

      // 프로젝트 컨텍스트 수집
      const cwd = process.cwd();
      const context = {
        buildTool: detectBuildTool(cwd),
        language: detectLanguage(cwd),
        packageManager: detectPackageManager(cwd),
      };

      // 프롬프트 생성
      const prompt = createMigrationPrompt(answer.question, context);

      console.log(chalk.blue.bold('\n🤖 Gemini AI가 답변을 생성하고 있습니다...\n'));

      const spinner = require('ora')('답변 생성 중...').start();
      const response = await generateText(prompt);
      spinner.stop();

      console.log(chalk.green('\n📝 답변:\n'));
      console.log(chalk.white(response));
      console.log('\n');
    } catch (error) {
      console.error(chalk.red('\n❌ Gemini API 연결 실패:'), error.message);
      console.log(chalk.yellow('\n확인 사항:'));
      console.log(chalk.white('  1. GEMINI_API_KEY 환경 변수가 올바르게 설정되었는지 확인'));
      console.log(chalk.white('  2. 인터넷 연결 확인'));
      console.log(chalk.white('  3. API 키가 유효한지 확인 (Google AI Studio에서 확인)'));
      process.exit(1);
    }
  });

// =========================================================
// Default command: `migrate-next` (no subcommand)
// =========================================================
function openFirstReviewableDiff(manifest) {
  const changes = Array.isArray(manifest?.changes) ? manifest.changes : [];
  for (const change of changes) {
    const result = openReviewDiff(change);
    if (result?.opened) {
      return { ...result, change };
    }
  }
  return { opened: false, command: null, change: null };
}

async function cleanupStaleStepArtifacts(projectRoot) {
  const reviewRoot = path.join(projectRoot, REVIEW_ROOT_DIR);
  if (!(await fs.pathExists(reviewRoot))) return;

  const entries = await fs.readdir(reviewRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^step\d+$/i.test(entry.name)) continue;
    await fs.remove(path.join(reviewRoot, entry.name));
  }
}

async function ensureOrchestratorMeta(cwd, targetPath, mode) {
  const metaDir = path.join(targetPath, '.nextify');
  const metaPath = path.join(metaDir, 'meta.json');
  await fs.ensureDir(metaDir);

  let sourceViteProjectRoot = mode === 'copy' ? cwd : null;

  // inplace에서는 원본 Vite 기준점을 미리 보존해야 레포트 비교가 가능합니다.
  if (mode !== 'copy') {
    const resolvedTargetPath = path.resolve(targetPath);
    const parentDir = path.dirname(resolvedTargetPath);
    const projectName = path.basename(resolvedTargetPath);
    const baselineSnapshotRoot = path.join(parentDir, `${projectName}__nextify_snapshots`, 'vite-baseline');
    const exists = await fs.pathExists(baselineSnapshotRoot);
    if (!exists) {
      console.log(chalk.gray('\n[inplace] Vite baseline 스냅샷 생성 중...'));
      await cloneProject(targetPath, baselineSnapshotRoot);
      console.log(chalk.gray(`[inplace] Vite baseline 스냅샷 생성 완료: ${baselineSnapshotRoot}`));
    }
    sourceViteProjectRoot = baselineSnapshotRoot;
  }

  const existingMeta = (await fs.pathExists(metaPath)) ? await fs.readJson(metaPath).catch(() => ({})) : {};
  const meta = {
    ...existingMeta,
    createdAt: existingMeta.createdAt || new Date().toISOString(),
    migrationRoot: targetPath,
    sourceViteProjectRoot,
    inplace: mode !== 'copy',
  };
  await fs.writeJson(metaPath, meta, { spaces: 2 });
}

function summarizeChangeTypes(changes) {
  const summary = { create: 0, modify: 0, delete: 0 };
  for (const change of Array.isArray(changes) ? changes : []) {
    if (summary[change?.type] !== undefined) {
      summary[change.type] += 1;
    }
  }
  return summary;
}

function normalizeErrorLike(errorLike) {
  if (errorLike instanceof Error) return errorLike;
  if (typeof errorLike === 'string') return new Error(errorLike);
  try {
    return new Error(JSON.stringify(errorLike));
  } catch {
    return new Error(String(errorLike));
  }
}

async function runPerformanceReportSafely(reportOptions) {
  let capturedRuntimeError = null;
  const onUncaughtException = (error) => {
    capturedRuntimeError = normalizeErrorLike(error);
  };
  const onUnhandledRejection = (reason) => {
    capturedRuntimeError = normalizeErrorLike(reason);
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  const reportPromise = generatePerformanceReport(reportOptions);
  let watcherId;
  try {
    await Promise.race([
      reportPromise,
      new Promise((_, reject) => {
        watcherId = setInterval(() => {
          if (capturedRuntimeError) {
            clearInterval(watcherId);
            reject(capturedRuntimeError);
          }
        }, 100);
      }),
    ]);
    if (watcherId) clearInterval(watcherId);
    return { success: true };
  } catch (error) {
    if (watcherId) clearInterval(watcherId);
    return { success: false, error: normalizeErrorLike(error) };
  } finally {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  }
}

async function runDefaultOrchestrator() {
  const cwd = process.cwd();

  // 1) detect & validate project type
  const pm = detectPackageManager(cwd);
  const lang = detectLanguage(cwd);
  const buildTool = detectBuildTool(cwd);
  const monorepo = detectMonorepo(cwd);
  const appType = detectAppType(cwd);

  console.log(chalk.blue.bold('🚀 Nextify 마이그레이션(기본 오케스트레이터)을 시작합니다...'));
  console.log(chalk.gray(`📦 패키지 매니저: ${chalk.cyan(pm)}`));
  console.log(chalk.gray(`📘 프로젝트 언어: ${chalk.cyan(lang === 'ts' ? 'TypeScript' : 'JavaScript')}`));
  console.log(chalk.gray(`🛠️  빌드 도구:     ${chalk.cyan(buildTool.toUpperCase())}`));
  if (monorepo) console.log(chalk.magenta(`🏢 모노레포 감지: ${chalk.bold(monorepo)}`));
  console.log(chalk.gray('--------------------------------------------------'));

  if (buildTool !== 'vite') {
    console.error(chalk.red.bold('\n⛔️ 지원하지 않는 프로젝트 형식입니다. (Vite 필수)'));
    process.exit(1);
  }
  if (appType !== 'spa') {
    console.error(chalk.red.bold('\n⛔️ SPA(index.html 보유) 프로젝트만 지원합니다.'));
    process.exit(1);
  }

  // 2) mode selection
  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: '마이그레이션을 어떻게 진행하시겠습니까?',
      choices: [
        { name: '새 폴더에 복사본을 만들어서 진행 (추천)', value: 'copy' },
        { name: '현재 폴더에 바로 적용 (주의: 원본 변경)', value: 'inplace' },
      ],
    },
  ]);

  let mode = answer.mode;
  let targetPath = cwd;

  if (mode === 'copy') {
    const parentDir = path.dirname(cwd);
    const currentDirName = path.basename(cwd);
    const defaultNewPath = path.join(parentDir, `${currentDirName}-nextified`);

    const { outputPath } = await inquirer.prompt([
      {
        type: 'input',
        name: 'outputPath',
        message: '복사본을 생성할 경로 (폴더명 또는 전체 경로):',
        default: defaultNewPath,
      },
    ]);

    const cleanedPath = outputPath.trim();
    const isAbsolutePath = path.isAbsolute(cleanedPath) || /^[A-Za-z]:[\\/]/.test(cleanedPath);

    if (isAbsolutePath) {
      targetPath = path.resolve(cleanedPath);
    } else if (cleanedPath.includes('/') || cleanedPath.includes('\\')) {
      targetPath = path.resolve(cwd, cleanedPath);
    } else {
      targetPath = path.join(parentDir, cleanedPath);
    }

    await cloneProject(cwd, targetPath);
    process.chdir(targetPath);
    console.log(chalk.blue(`\n📂 작업 경로가 변경되었습니다: ${targetPath}`));
  }

  // 이전 실행에서 남아있는 step 아티팩트를 정리합니다.
  await cleanupStaleStepArtifacts(targetPath);
  await ensureOrchestratorMeta(cwd, targetPath, mode);

  const stepEntries = [
    ['step1', runStep1],
    ['step2', runStep2],
    ['step3', runStep3],
    ['step4', runStep4],
    ['step5', runStep5],
    ['step6', runStep6],
    ['step7', runStep7],
  ];

  const finalReviewSession = await createSnapshotReviewSession(targetPath, 'step7', async (projectRoot) => {
    for (const [stepName, stepRunner] of stepEntries) {
      const partNum = stepName.replace('step', '');
      console.log(chalk.yellow(`\n==================== Part ${partNum} (${stepName}) ====================`));
      await stepRunner(projectRoot);
    }
  });

  const { manifest, manifestPath } = finalReviewSession;

  if (!manifestPath || !Array.isArray(manifest?.changes) || manifest.changes.length === 0) {
    console.log(chalk.green('\n✔ step1~step7 완료: 최종 변경 없음'));
    const installCmd = getInstallCommand(pm);
    console.log(chalk.yellow('\n👉 다음 단계 안내'));
    console.log(chalk.white(`   - ${installCmd} (의존성 설치)`));
    console.log(chalk.white('   - 마이그레이션된 프로젝트에서 빌드/실행을 확인하세요. '));
    return;
  }

  const typeSummary = summarizeChangeTypes(manifest.changes);
  console.log(chalk.green(`\n✔ step1~step7 완료: 최종 리뷰 대상 ${manifest.changes.length}개 변경`));
  console.log(
    chalk.white(
      `변경사항 type: create ${typeSummary.create}, modify ${typeSummary.modify}, delete ${typeSummary.delete}`,
    ),
  );

  // 1) 성능 레포트 생성
  console.log(chalk.yellow('\n📊 성능 레포트 생성을 시작합니다.'));
  const reportPath = path.join(targetPath, 'nextify-performance-report.md');
  const reportResult = await runPerformanceReportSafely({
    projectRoot: targetPath,
    outputMarkdownPath: reportPath,
  });
  if (!reportResult.success) {
    console.log(chalk.yellow(`⚠️  성능 레포트 생성에 실패했습니다: ${reportResult.error.message}`));
    console.log(chalk.gray('   - 마이그레이션 결과는 유지됩니다. 필요 시 `migrate-next report`로 재시도하세요.'));
  }

  // 2) 코드 리뷰 여부 확인
  const { useReview } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useReview',
      message: 'diff 및 AI를 통한 코드 리뷰를 진행하시겠습니까?',
      default: true,
    },
  ]);

  if (!useReview) {
    const installCmd = getInstallCommand(pm);
    console.log(chalk.green('\n✔ 마이그레이션 완료.'));
    console.log(chalk.yellow('\n👉 다음 단계 안내'));
    console.log(chalk.white(`   - ${installCmd} (의존성 설치)`));
    console.log(chalk.white('   - 마이그레이션된 프로젝트에서 빌드/실행을 확인하세요.'));
    console.log(chalk.white(`   - 성능 레포트 확인: ${reportPath}`));
    return;
  }

  // 3) 코드 리뷰 진행
  const extReady = await ensureReviewExtensionReady();
  if (extReady.installed && extReady.status?.command) {
    focusReviewPanel(extReady.status);
  }
  const openResult = openFirstReviewableDiff(manifest);
  if (!openResult.opened) {
    console.log(chalk.yellow('자동으로 diff를 열지 못했습니다. Nextify Review 패널에서 수동으로 열어주세요.'));
  }

  console.log(chalk.yellow('\n🔎 Gemini CLI 설치 상태를 확인합니다.'));
  try {
    const setup = await ensureGeminiCliReady({
      pm,
      cwd: targetPath,
      onInfo: (msg) => console.log(chalk.gray(`   - ${msg}`)),
    });
    if (setup.installedNow) {
      console.log(chalk.green('✅ Gemini CLI 자동 설치 및 검증 완료.'));
    } else {
      console.log(chalk.gray('   - Gemini CLI가 이미 설치되어 있습니다.'));
    }
  } catch (err) {
    const fallbackInstall =
      pm === 'yarn'
        ? 'yarn global add @google/gemini-cli'
        : pm === 'pnpm'
          ? 'pnpm add -g @google/gemini-cli'
          : 'npm install -g @google/gemini-cli';
    console.error(chalk.red('\n❌ Gemini CLI 자동 설치에 실패했습니다.'));
    if (err?.lastError?.message) {
      console.error(chalk.red(`   - 원인: ${err.lastError.message}`));
    } else if (err?.message) {
      console.error(chalk.red(`   - 원인: ${err.message}`));
    }
    console.log(chalk.yellow('   - 수동 설치 후 다시 실행하세요:'));
    console.log(chalk.white(`     ${fallbackInstall}`));
    throw err;
  }

  console.log(chalk.yellow('\n⏳ 최종 Gemini CLI 리뷰를 시작합니다.'));
  console.log(
    chalk.gray(
      '   (리뷰는 view-only입니다. 세션은 IDE 패널에서 diff 확인 및 before/after 경로 복사로 진행하세요.)',
    ),
  );

  const aiAbort = new AbortController();
  const onSigint = () => {
    if (!aiAbort.signal.aborted) {
      process.stdout.write('\n');
      console.log(chalk.yellow('⏹ Ctrl+C 감지: 현재 Gemini CLI 리뷰를 중단합니다.'));
      aiAbort.abort();
    }
  };

  process.on('SIGINT', onSigint);
  try {
    await runAiReviewSessionStream({
      sessionPath: manifestPath,
      signal: aiAbort.signal,
      transport: 'cli',
      mode: 'interactive-seeded',
      model: process.env.NEXTIFY_GEMINI_CLI_MODEL || 'gemini-2.5-flash-lite',
      workingDirectory: targetPath,
      onChunk: (t) => process.stdout.write(t),
    });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.error(chalk.red('\n❌ Gemini CLI를 찾을 수 없습니다.'));
      console.log(chalk.yellow('   - Gemini CLI를 설치하고 `gemini` 명령이 PATH에서 실행되는지 확인하세요.'));
    }
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
  }

  console.log(chalk.green('\n✔ 코드 리뷰 완료.'));

  const installCmd = getInstallCommand(pm);
  console.log(chalk.yellow('\n👉 다음 단계 안내'));
  console.log(chalk.white(`   - ${installCmd} (의존성 설치)`));
  console.log(chalk.white('   - 마이그레이션된 프로젝트에서 빌드/실행을 확인하세요.'));
  console.log(chalk.white(`   - 성능 레포트 확인: ${reportPath}`));
}

// Only run default orchestrator when user calls `migrate-next` with no subcommand.
const argv = process.argv.slice(2);
if (argv.length === 0) {
  runDefaultOrchestrator().catch((e) => {
    console.error(chalk.red('\n❌ 기본 오케스트레이터 오류:'), e?.message || e);
    process.exit(1);
  });
} else {
  program.parse(process.argv);
}
