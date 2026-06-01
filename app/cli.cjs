#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');

(function loadProjectEnvFiles() {
  const fs = require('fs');
  const root = process.cwd();
  const merged = {};
  for (const name of ['.env', '.env.local']) {
    const abs = path.join(root, name);
    if (!fs.existsSync(abs)) continue;
    try {
      Object.assign(merged, dotenv.parse(fs.readFileSync(abs, 'utf8')));
    } catch {
      // 손상된 파일 등은 건너뜀
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
})();
// 전역 패키지 옆 .env.local: 위·셸에서 아직 없는 변수만 채움
dotenv.config({ path: path.join(__dirname, '.env.local') });

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
  const tooOld = major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR);
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

// =========================================================
// 로그 유틸 — 색상 규칙을 한 곳에서 관리합니다.
//   logSection : 파란 굵은 헤더 + 회색 구분선 (단계·페이즈 경계)
//   logSuccess : 초록 ✔  (완료·성공)
//   logWarn    : 노랑 ⚠  (경고·우회 가능한 실패)
//   logError   : 빨강 ✖  (치명적 에러, process.exit 전)
//   logStep    : 회색 ·  (하위 진행 항목·부가 정보)
// =========================================================
const SEP = chalk.gray(
  '──────────────────────────────────────────────────────────────────────────────────────────────────────',
);
function logSection(title) {
  console.log('\n' + chalk.blue.bold(title));
  if (!/^Part \d+ \(/.test(title)) {
    console.log(SEP);
  }
}
function logSuccess(msg) {
  console.log(chalk.green('✔ ' + msg));
}
function logWarn(msg) {
  console.log(chalk.yellow('⚠ ' + msg));
}
function logError(msg) {
  console.error(chalk.red('✖ ' + msg));
}
function logInfo(msg) {
  console.log(chalk.white('  · ' + msg));
}
function logStep(msg) {
  console.log(chalk.gray('  · ' + msg));
}

function formatProjectRelativePath(projectRoot, filePath) {
  const rel = path.relative(projectRoot, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return rel;
}

// 모듈 경로 변경 (step 폴더의 index.cjs )
const { runStep1 } = require('./src/step1/index.cjs');
const { runStep2 } = require('./src/step2/index.cjs');
const { runStep3 } = require('./src/step3/index.cjs');
const { runStep4 } = require('./src/step4/index.cjs');
const { runStep5 } = require('./src/step5/index.cjs');
const { runStep6 } = require('./src/step6/index.cjs');
const { runValidation } = require('./src/validation/index.cjs');
const { runEnvAndDependencyGuide } = require('./src/guides/env-guide.cjs');

const {
  detectPackageManager,
  detectLanguage,
  detectBuildTool,
  detectMonorepo,
  detectAppType,
  getInstallCommand,
} = require('./src/utils/project-info.cjs');
const { cloneProject } = require('./src/utils/copy.cjs');
const { resolveCopyTargetPath } = require('./src/utils/copy-target-resolver.cjs');
const { ensureGeminiApiKey } = require('./src/utils/gemini-precheck.cjs');
const {
  REVIEW_ROOT_DIR,
  REVIEW_EXTENSION_MARKET_ID,
  createStepReviewSession,
  createSnapshotReviewSession,
  getEditorCommands,
  runEditorCommand,
  getReviewExtensionStatus,
  focusReviewPanel,
  installReviewExtension,
} = require('./src/utils/review-session.cjs');
const { generateText, createMigrationPrompt, generateTextStream } = require('./src/utils/gemini-client.cjs');
const { runAskApply } = require('./src/utils/ai-file-apply.cjs');
const { runAiReviewSessionStream } = require('./src/utils/ai-review-session.cjs');
const { printRelPathsBlock } = require('./src/utils/path-list-print.cjs');
const { createBaseMigrationSnapshot, ensureNextifyMeta } = require('./src/report/performance-report.cjs');
const fs = require('fs-extra');
const pkg = require('./package.json');

const program = new Command();

program.name('migrate-next').description('React(Vite) 프로젝트를 Next.js로 마이그레이션하는 CLI').version(pkg.version);

program.addHelpText(
  'after',
  `\n예시:\n` +
    `  migrate-next\n` +
    `    - step1~step5 기본 마이그레이션과 TypeScript 검증을 실행합니다.\n` +
    `    - Next.js 심화 변환, 성능 레포트, AI 리뷰는 별도 명령으로 실행합니다.\n` +
    `  migrate-next advanced\n` +
    `    - Next.js 심화 변환(step6: next/image, next/font, Dynamic Import 등)을 실행합니다.\n` +
    `  migrate-next steps\n` +
    `    - 같은 폴더에서 step1~step6까지 순차 실행합니다. (\`.ai-migration\`/성능 레포트/Gemini 리뷰는 만들지 않습니다.)\n` +
    `    - 이후 \`migrate-next report\`(레포트) 또는 \`migrate-next review\`(리뷰)로 부분 기능만 별도 실행할 수 있습니다.\n` +
    `  migrate-next review\n` +
    `    - 기존 .ai-migration/stepN/session.json 으로 diff 확인과 Gemini CLI 리뷰를 실행합니다.\n` +
    `  migrate-next report\n` +
    `    - 성능 비교 레포트만 별도 재생성.\n` +
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
    logSection('Next.js 마이그레이션 Step 1');

    const cwd = process.cwd();

    // 1. 프로젝트 상태 감지
    const pm = detectPackageManager(cwd);
    const lang = detectLanguage(cwd);
    const buildTool = detectBuildTool(cwd);
    const monorepo = detectMonorepo(cwd);
    const appType = detectAppType(cwd);

    // 정보 출력
    logStep(`패키지 매니저: ${chalk.cyan(pm)}`);
    logStep(`언어: ${chalk.cyan(lang === 'ts' ? 'TypeScript' : 'JavaScript')}`);
    logStep(`빌드 도구: ${chalk.cyan(buildTool.toUpperCase())}`);
    if (monorepo) logStep(chalk.magenta(`모노레포 감지: ${chalk.bold(monorepo)}`));

    // 2. 가드
    if (buildTool !== 'vite') {
      logError('지원하지 않는 프로젝트 형식입니다. (Vite 필수)');
      process.exit(1);
    }
    if (appType !== 'spa') {
      logError('SPA(index.html 보유) 프로젝트만 지원합니다.');
      process.exit(1);
    }

    // 3. 실행
    try {
      let mode;
      let targetPath = cwd;

      if (options.review) {
        mode = 'review';
      } else if (options.output) {
        mode = 'copy';
      } else if (options.inplace) {
        mode = 'inplace';
      } else {
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

      if (mode === 'copy') {
        targetPath = await resolveCopyTargetPath({
          cwd,
          predefinedPath: options.output ? options.output.trim() : null,
        });
        await cloneProject(cwd, targetPath, {
          startMessage: '작업용 프로젝트를 복사하는 중...',
          successMessage: `작업용 프로젝트 복사 완료: ${targetPath}`,
          failMessage: '작업용 프로젝트 복사 실패',
        });
        process.chdir(targetPath);
        logStep(`작업 경로: ${targetPath}`);
      }

      if (mode === 'review') {
        logStep('리뷰 세션을 준비하는 중입니다...');
        const reviewSession = await createStepReviewSession(cwd, 'step1', runStep1);

        if (reviewSession.manifest.changes.length === 0) {
          logSuccess('변경 사항이 없어 리뷰 세션을 만들지 않았습니다.');
          return;
        }

        logSuccess(`Step 1 preview 생성 완료 (${reviewSession.manifest.changes.length}개 변경)`);

        const extensionStatus = await promptAndEnsureNextifyReviewExtension();
        if (extensionStatus.installed && extensionStatus.command) {
          focusReviewPanel(extensionStatus);
        }

        logWarn('Step 1은 리뷰 대기 상태에서 멈췄습니다.');
        logStep('왼쪽: 원본 파일 / 오른쪽: .ai-migration 안의 migrated 파일');
        logStep('Nextify Review 패널은 view-only입니다(diff·경로 복사). 변경을 적용하려면 직접 편집·반영하세요.');
        logSuccess('변경 내용 검토 파일을 저장했습니다.');
        logStep(`저장 위치: ${formatProjectRelativePath(cwd, reviewSession.manifestPath)}`);
        return;
      }

      // Nextify 메타 저장 (baseline Vite 경로 기록)
      try {
        const metaDir = path.join(targetPath, '.nextify');
        const metaPath = path.join(metaDir, 'meta.json');
        await fs.ensureDir(metaDir);
        let sourceViteProjectRoot = mode === 'copy' ? cwd : null;

        // inplace라면 step1 적용 전에 Vite 원본 비교용 복사본 자동 생성
        // (step1이 package.json/scripts 등을 Next로 바꿔서 원본이 사라지기 때문)
        if (mode !== 'copy') {
          const resolvedTargetPath = path.resolve(targetPath);
          const parentDir = path.dirname(resolvedTargetPath);
          const projectName = path.basename(resolvedTargetPath);
          const baselineSnapshotRoot = path.join(parentDir, `${projectName}__nextify_snapshots`, 'vite-baseline');
          const exists = await fs.pathExists(baselineSnapshotRoot);
          if (!exists) {
            await cloneProject(targetPath, baselineSnapshotRoot, {
              silent: true,
            });
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
        logWarn(`.nextify/meta.json 저장 실패: ${e.message}`);
      }

      //  Step 1 실행
      await runStep1(targetPath);

      // 완료 안내
      const installCmd = getInstallCommand(pm);

      if (mode === 'copy') {
        const relativePath = path.relative(cwd, targetPath);
        logSection('다음 단계');
        logStep(`cd ${relativePath}`);
        logStep(`${installCmd}  (의존성 설치)`);
        logStep('migrate-next step2');
      } else {
        logSection('다음 단계');
        logStep(`${installCmd}  (의존성 설치 후 migrate-next step2 실행)`);
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
  .description('3단계: 라우팅 페이지 변환')
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
  .description('6단계: Next.js 심화 변환')
  .option('--skip-validation', '이 단계에서 타입 검증(validation) 호출 생략')
  .option('--no-typecheck-autofix', 'validation 단계: 결정론적 TypeScript 자동 수정 비활성화')
  .option('--no-typecheck-ai-fix', 'validation 단계: AI 잔여 빌드 에러 보정 비활성화 (GEMINI_API_KEY)')
  .option('--typecheck-ai-fix-budget <n>', 'validation 단계: AI 보정 최대 파일 수 (기본 5)', (v) => Number(v))
  .action(async (options) => {
    try {
      const projectRoot = process.cwd();
      await runAdvancedMigrationWithSession(projectRoot, {
        skipValidation: options.skipValidation,
        typecheckAutofix: options.typecheckAutofix,
        typecheckAiFix: options.typecheckAiFix,
        typecheckAiFixBudget: options.typecheckAiFixBudget,
      });
      await printAdvancedNextSteps(projectRoot);
    } catch (error) {
      console.error(chalk.red('\n❌ Step 6 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Advanced
// =========================================================
program
  .command('advanced')
  .description('Next.js 심화 변환 실행')
  .option('--skip-validation', '이 단계에서 타입 검증(validation) 호출 생략')
  .option('--no-typecheck-autofix', 'validation 단계: 결정론적 TypeScript 자동 수정 비활성화')
  .option('--no-typecheck-ai-fix', 'validation 단계: AI 잔여 빌드 에러 보정 비활성화 (GEMINI_API_KEY)')
  .option('--typecheck-ai-fix-budget <n>', 'validation 단계: AI 보정 최대 파일 수 (기본 5)', (v) => Number(v))
  .action(async (options) => {
    try {
      const projectRoot = process.cwd();
      await runAdvancedMigrationWithSession(projectRoot, {
        skipValidation: options.skipValidation,
        typecheckAutofix: options.typecheckAutofix,
        typecheckAiFix: options.typecheckAiFix,
        typecheckAiFixBudget: options.typecheckAiFixBudget,
      });
      await printAdvancedNextSteps(projectRoot);
    } catch (error) {
      console.error(chalk.red('\n❌ advanced 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Steps (step1~step6 only)
// =========================================================
program
  .command('steps')
  .description('step1~step6 순차 실행 (성능 레포트/AI 리뷰 제외)')
  .action(async () => {
    try {
      const projectRoot = process.cwd();
      // step5~7 는 Gemini API 를 사용하므로 시작 전에 키 보유를 확정한다.
      await ensureGeminiApiKey({ projectRoot });
      const stepEntries = [
        ['step1', runStep1],
        ['step2', runStep2],
        ['step3', runStep3],
        ['step4', runStep4],
        ['step5', runStep5],
        ['step6', runStep6],
      ];

      for (const [stepName, stepRunner] of stepEntries) {
        const partNum = stepName.replace('step', '');
        logSection(`Part ${partNum} (${stepName})`);
        if (stepName === 'step6') {
          try {
            await createBaseMigrationSnapshot(projectRoot);
          } catch (snapshotErr) {
            logWarn(`심화 변환 전 비교용 복사본 생성 실패: ${snapshotErr?.message || snapshotErr}`);
          }
        }
        await stepRunner(projectRoot);
        if (stepName === 'step6') {
          await runAdvancedTypeScriptValidation(projectRoot);
        }
      }

      await ensureNextifyMeta(projectRoot, {
        advancedCompleted: true,
        advanced: { completedAt: new Date().toISOString() },
      });
      logSuccess('step1~step6 순차 실행 완료 (레포트/AI 리뷰 미실행).');
      logSection('필요 시 추가 실행');
      logInfo('성능 레포트: migrate-next report');
      logInfo('기본 마이그레이션: migrate-next');
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
  .option('--run-advanced', '레포트 생성 전에 Next.js 심화 변환을 먼저 적용')
  .option('--baseline <path>', 'Vite 원본 프로젝트 루트 경로 (메타가 없으면 필수)')
  .option('--output <path>', '생성할 마크다운 레포트 파일 경로 (기본: <projectRoot>/nextify-performance-report.md)')
  .option('--runs <number>', 'Lighthouse 측정 횟수 (기본 3)', (v) => Number(v), 3)
  .option('--warmup-runs <number>', 'Lighthouse 워밍업 횟수 (기본 1)', (v) => Number(v), 1)
  .action(async (options) => {
    const reportStartedAt = Date.now();
    try {
      const projectRoot = process.cwd();
      const outputPath = options.output
        ? path.resolve(options.output)
        : path.join(projectRoot, 'nextify-performance-report.md');
      const baselineViteRoot = options.baseline ? path.resolve(options.baseline) : undefined;
      const lighthouseRuns = Number.isFinite(options.runs) && options.runs > 0 ? Math.floor(options.runs) : 3;
      const warmupRuns =
        Number.isFinite(options.warmupRuns) && options.warmupRuns >= 0 ? Math.floor(options.warmupRuns) : 1;

      if (options.runAdvanced) {
        await runAdvancedMigrationWithSession(projectRoot);
      }

      const { generatePerformanceReport } = require('./src/report/performance-report.cjs');
      await generatePerformanceReport({
        projectRoot,
        baselineViteRoot,
        outputMarkdownPath: outputPath,
        lighthouseRuns,
        warmupRuns,
        startedAt: reportStartedAt,
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
      await ensureGeminiApiKey();

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
        printRelPathsBlock(chalk.green, '\n✔ 적용 완료', written);
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
// Command: Review (Gemini CLI review using an existing session.json)
// =========================================================
program
  .command('review')
  .description('기존 마이그레이션 세션(session.json)으로 Gemini CLI 코드 리뷰만 단독 실행')
  .option('--session <path>', 'session.json 경로 (생략 시 .ai-migration/stepN/session.json 자동 탐색, N이 큰 것 우선)')
  .action(async (options) => {
    try {
      const cwd = process.cwd();

      let sessionPath = options.session ? path.resolve(options.session) : null;
      if (sessionPath && !(await fs.pathExists(sessionPath))) {
        const archivePath = getArchivedReviewSessionPath(sessionPath);
        if (!(await fs.pathExists(archivePath))) {
          logError(`지정한 session.json을 찾을 수 없습니다: ${sessionPath}`);
          process.exit(1);
        }
      }

      if (!sessionPath) {
        sessionPath = await findLatestStepSession(cwd);
      }

      if (!sessionPath) {
        logError('재사용할 session.json을 찾지 못했습니다.');
        logInfo('먼저 `migrate-next`로 마이그레이션을 진행하거나, --session <path>로 직접 지정하세요.');
        process.exit(1);
      }

      logSection('코드 리뷰 및 diff 확인');
      logStep('변경 전후 diff 창을 열고 Gemini CLI 리뷰를 시작합니다.');
      logStep('리뷰는 view-only이며, 리뷰 결과를 참고해 필요한 변경 사항을 직접 반영하세요.');
      logStep('진행 중 중단하려면 Ctrl+C를 누르세요.');
      logStep('@파일경로를 붙여 넣어 특정 파일을 Gemini에 참조시킬 수 있습니다.');
      logStep('확장이 보이지 않으면 Marketplace에서 `capstone0123.nextify-review`를 설치하세요.');
      logStep('Gemini CLI가 없다면 `npm install -g @google/gemini-cli` 후 다시 실행하세요.');

      await setReviewSessionActive(sessionPath, true);
      try {
        await runReviewSessionFlow({
          sessionPath,
          workingDirectory: cwd,
          workspaceFolder: getProjectRootFromSessionPath(sessionPath) || cwd,
        });
      } finally {
        await closeReviewSession(sessionPath);
      }

      logSuccess('코드 리뷰 완료.');
    } catch (error) {
      console.error(chalk.red('\n❌ review 오류 발생:'), error?.message || error);
      process.exit(1);
    }
  });

// =========================================================
// Default command: `migrate-next` (no subcommand)
// =========================================================
function addWorkspaceFolderToEditor(workspaceFolder) {
  const abs = path.resolve(workspaceFolder);
  for (const binary of getEditorCommands()) {
    const result = runEditorCommand(binary, ['--reuse-window', '--add', abs], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return { ok: true, command: binary };
    }
    if (result?.error?.code === 'ENOENT') continue;
  }
  return { ok: false, command: null };
}

/**
 * Nextify Review 확장 설치 여부를 확인하고, 필요 시 설치를 물어봅니다.
 * `NEXTIFY_ASSUME_YES=1`이면 확인 없이 설치를 시도합니다.
 */
async function promptAndEnsureNextifyReviewExtension() {
  const marketplaceUrl = `https://marketplace.visualstudio.com/items?itemName=${REVIEW_EXTENSION_MARKET_ID}`;
  let status = getReviewExtensionStatus();

  if (status.installed && status.command) {
    return status;
  }

  if (!status.editorAvailable || !status.command) {
    logWarn('VS Code/Cursor CLI를 찾지 못해 Nextify Review 확장 자동 설치를 건너뜁니다.');
    logStep(`Marketplace에서 수동 설치: ${marketplaceUrl}`);
    return status;
  }

  let shouldInstall = /^(1|true|yes)$/i.test(String(process.env.NEXTIFY_ASSUME_YES || ''));
  if (!shouldInstall) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Nextify Review 확장(\`${REVIEW_EXTENSION_MARKET_ID}\`)이 없습니다. 지금 설치할까요?`,
        default: true,
      },
    ]);
    shouldInstall = confirm;
  }

  if (!shouldInstall) {
    logStep(`패널 사용 시 Marketplace에서 설치: ${marketplaceUrl}`);
    return status;
  }

  const installResult = installReviewExtension(status.command);
  if (installResult.installed) {
    logSuccess(`Nextify Review 확장 설치를 실행했습니다. (${installResult.command})`);
    status = getReviewExtensionStatus();
    return status;
  }

  logWarn('확장 자동 설치 요청에 실패했습니다. Marketplace에서 설치해 주세요.');
  logStep(marketplaceUrl);
  if (installResult.stderr) {
    logStep(`(${installResult.stderr.trim()})`);
  }
  return status;
}

async function runReviewSessionFlow({ sessionPath, workingDirectory, workspaceFolder = null }) {
  const extensionStatus = await promptAndEnsureNextifyReviewExtension();

  if (workspaceFolder) {
    addWorkspaceFolderToEditor(workspaceFolder);
  }

  refreshReviewPanel(extensionStatus);

  if (extensionStatus.installed && extensionStatus.command) {
    focusReviewPanel(extensionStatus);
  }

  const aiAbort = new AbortController();
  const onSigint = () => {
    if (!aiAbort.signal.aborted) {
      process.stdout.write('\n');
      logWarn('Ctrl+C 감지: 현재 Gemini CLI 리뷰를 중단합니다.');
      aiAbort.abort();
    }
  };

  process.on('SIGINT', onSigint);
  try {
    await runAiReviewSessionStream({
      sessionPath,
      signal: aiAbort.signal,
      transport: 'cli',
      mode: 'interactive-seeded',
      model: process.env.NEXTIFY_GEMINI_CLI_MODEL || 'gemini-2.5-flash-lite',
      workingDirectory,
      onChunk: (t) => process.stdout.write(t),
    });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      logError('Gemini CLI를 찾을 수 없습니다.');
      logWarn(
        'Gemini CLI를 설치하고 `gemini` 명령이 PATH에서 실행되는지 확인하세요. (예: `npm install -g @google/gemini-cli`)',
      );
    }
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function getArchivedReviewSessionPath(sessionPath) {
  return path.join(path.dirname(sessionPath), 'session.review.json');
}

function getProjectRootFromSessionPath(sessionPath) {
  const resolved = path.resolve(String(sessionPath || ''));
  const normalized = resolved.replace(/\\/g, '/');
  const marker = `/${REVIEW_ROOT_DIR}/`;
  const idx = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (idx < 0) {
    return null;
  }
  return resolved.slice(0, idx);
}

async function setReviewSessionActive(sessionPath, active) {
  if (!sessionPath) {
    return null;
  }

  const archivePath = getArchivedReviewSessionPath(sessionPath);
  let manifest = null;
  if (await fs.pathExists(sessionPath)) {
    manifest = await fs.readJson(sessionPath);
  } else if (active === true && (await fs.pathExists(archivePath))) {
    manifest = await fs.readJson(archivePath);
  } else {
    return null;
  }

  if (active === true && (!Array.isArray(manifest.changes) || manifest.changes.length === 0)) {
    const archivedPath = manifest.archivedManifestPath || archivePath;
    if (await fs.pathExists(archivedPath)) {
      manifest = await fs.readJson(archivedPath);
    }
  }

  const now = new Date().toISOString();
  if (active === true) {
    const nextManifest = {
      ...manifest,
      active: true,
      status: 'active',
      activatedAt: now,
      closedAt: null,
    };
    await fs.writeJson(sessionPath, nextManifest, { spaces: 2 });
    return nextManifest;
  }

  const fullManifest = {
    ...manifest,
    active: false,
    status: 'closed',
    activatedAt: manifest.activatedAt || null,
    closedAt: now,
  };
  await fs.writeJson(archivePath, fullManifest, { spaces: 2 });

  const closedManifest = {
    version: manifest.version || 1,
    step: manifest.step,
    createdAt: manifest.createdAt,
    active: false,
    status: 'closed',
    activatedAt: manifest.activatedAt || null,
    closedAt: now,
    reviewRoot: manifest.reviewRoot,
    beforeRoot: manifest.beforeRoot,
    placeholdersRoot: manifest.placeholdersRoot,
    filesRoot: manifest.filesRoot,
    changeCount: Array.isArray(manifest.changes) ? manifest.changes.length : manifest.changeCount || 0,
    archivedManifestPath: archivePath,
    changes: [],
  };
  await fs.writeJson(sessionPath, closedManifest, { spaces: 2 });
  return closedManifest;
}

function refreshReviewPanel(extensionStatus = null) {
  const status = extensionStatus || getReviewExtensionStatus();
  if (!status?.command) {
    return { refreshed: false, command: null, reason: 'editor-not-found' };
  }

  const result = runEditorCommand(status.command, ['--reuse-window', '--command', 'nextifyReview.refreshSession'], {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (!result.error && result.status === 0) {
    return { refreshed: true, command: status.command };
  }
  return { refreshed: false, command: status.command, reason: 'refresh-command-failed' };
}

async function closeReviewSession(sessionPath) {
  if (!sessionPath) return;
  try {
    if (await fs.pathExists(sessionPath)) {
      await setReviewSessionActive(sessionPath, false);
      refreshReviewPanel();
      logStep('리뷰 세션을 닫았습니다. session.json은 보존되며 Nextify Review 패널만 비활성화됩니다.');
    }
  } catch (error) {
    logWarn(`리뷰 세션 종료 중 session.json 상태 업데이트 실패: ${error?.message || error}`);
  }
}

async function saveInactiveReviewArchive(sessionPath, manifest) {
  if (!sessionPath || !manifest || !Array.isArray(manifest.changes) || manifest.changes.length === 0) {
    return null;
  }

  const archivePath = getArchivedReviewSessionPath(sessionPath);
  const now = new Date().toISOString();
  await fs.writeJson(
    archivePath,
    {
      ...manifest,
      active: false,
      status: 'closed',
      activatedAt: null,
      closedAt: now,
    },
    { spaces: 2 },
  );
  await fs.remove(sessionPath);
  return archivePath;
}

async function printBaseMigrationFinalGuide(projectRoot, mode = 'copy') {
  await runEnvAndDependencyGuide(projectRoot);
  logSection('추가 명령어');
  if (mode === 'copy') {
    logInfo('먼저 마이그레이션된 프로젝트 폴더로 이동하세요.');
    console.log(chalk.gray(`    cd "${projectRoot}"`));
  } else {
    logInfo('현재 폴더에서 아래 명령어를 실행하세요.');
  }
  logInfo('migrate-next advanced  (Next.js 심화 변환)');
  logInfo('migrate-next report    (성능 비교 레포트 생성)');
  logInfo('migrate-next review    (diff 확인 및 AI 코드 리뷰)');
}

async function printAdvancedNextSteps(projectRoot) {
  console.log(chalk.white('\n심화 변환 후 확인할 항목'));
  console.log(chalk.white('\n빌드 확인'));
  console.log(chalk.gray('  마이그레이션된 프로젝트에서 빌드·실행을 다시 확인하세요.'));
  logSection('추가 명령어');
  logInfo('현재 마이그레이션된 프로젝트 폴더에서 아래 명령어를 실행하세요.');
  logInfo('migrate-next report    (성능 비교 레포트 생성)');
  logInfo('migrate-next review    (diff 확인 및 AI 코드 리뷰)');
}

async function runAdvancedTypeScriptValidation(projectRoot, options = {}) {
  if (options.skipValidation === true) return;

  logSection('TypeScript 검증');
  await runValidation(projectRoot, {
    autofix: options.typecheckAutofix !== false,
    aiFix: options.typecheckAiFix !== false,
    aiFixBudget: options.typecheckAiFixBudget,
  });
}

async function runAdvancedMigrationWithSession(projectRoot, options = {}) {
  const session = await createSnapshotReviewSession(projectRoot, 'step6', async (root) => {
    try {
      await createBaseMigrationSnapshot(root);
    } catch (snapshotErr) {
      logWarn(`심화 변환 전 비교용 복사본 생성 실패: ${snapshotErr?.message || snapshotErr}`);
    }

    await runStep6(root, options);
    await runAdvancedTypeScriptValidation(root, options);
    await ensureNextifyMeta(root, {
      advancedCompleted: true,
      advanced: { completedAt: new Date().toISOString() },
    });
  });

  const changeCount = Array.isArray(session?.manifest?.changes) ? session.manifest.changes.length : 0;
  if (changeCount > 0) {
    logSuccess('심화 변환 검토 파일을 저장했습니다.');
    logStep(`저장 위치: ${formatProjectRelativePath(projectRoot, session.manifestPath)}`);
  }
  return session;
}

/**
 * `.ai-migration/stepN/session.json` 후보 중 step 번호가 가장 큰(즉 가장 최근 단계의) 파일 경로를 반환합니다.
 * 없으면 null.
 * @param {string} projectRoot
 * @returns {Promise<string|null>}
 */
async function findLatestStepSession(projectRoot) {
  const reviewRoot = path.join(projectRoot, REVIEW_ROOT_DIR);
  if (!(await fs.pathExists(reviewRoot))) return null;

  const entries = await fs.readdir(reviewRoot, { withFileTypes: true });
  let bestStep = -1;
  let bestPath = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = /^step(\d+)$/i.exec(entry.name);
    if (!m) continue;
    const stepNum = Number(m[1]);
    const candidate = path.join(reviewRoot, entry.name, 'session.json');
    const archiveCandidate = getArchivedReviewSessionPath(candidate);
    if (!(await fs.pathExists(candidate)) && !(await fs.pathExists(archiveCandidate))) continue;
    if (stepNum > bestStep) {
      bestStep = stepNum;
      bestPath = candidate;
    }
  }
  return bestPath;
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
      await cloneProject(targetPath, baselineSnapshotRoot, {
        silent: true,
      });
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

async function runDefaultOrchestrator() {
  const cwd = process.cwd();

  // 1) detect & validate project type
  const pm = detectPackageManager(cwd);
  const lang = detectLanguage(cwd);
  const buildTool = detectBuildTool(cwd);
  const monorepo = detectMonorepo(cwd);
  const appType = detectAppType(cwd);

  logSection('Nextify 마이그레이션 시작');
  logStep(`패키지 매니저: ${chalk.cyan(pm)}`);
  logStep(`언어: ${chalk.cyan(lang === 'ts' ? 'TypeScript' : 'JavaScript')}`);
  logStep(`빌드 도구: ${chalk.cyan(buildTool.toUpperCase())}`);
  if (monorepo) logStep(chalk.magenta(`모노레포 감지: ${chalk.bold(monorepo)}`));

  if (buildTool !== 'vite') {
    logError('지원하지 않는 프로젝트 형식입니다. (Vite 필수)');
    process.exit(1);
  }
  if (appType !== 'spa') {
    logError('SPA(index.html 보유) 프로젝트만 지원합니다.');
    process.exit(1);
  }

  // 마이그레이션 시작 전에 Gemini 키 보유 여부를 먼저 확인한다.
  // (step5~7 와 최종 리뷰가 키에 의존하므로, 작업 도중 멈추지 않도록 사전 차단)
  await ensureGeminiApiKey({ projectRoot: cwd });

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
    targetPath = await resolveCopyTargetPath({ cwd });

    await cloneProject(cwd, targetPath, {
      startMessage: '작업용 프로젝트를 복사하는 중...',
      successMessage: `작업용 프로젝트 복사 완료: ${targetPath}`,
      failMessage: '작업용 프로젝트 복사 실패',
    });
    process.chdir(targetPath);
    logStep(`작업 경로: ${targetPath}`);
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
  ];

  const finalReviewSession = await createSnapshotReviewSession(
    targetPath,
    'step5',
    async (projectRoot) => {
      for (const [stepName, stepRunner] of stepEntries) {
        const partNum = stepName.replace('step', '');
        logSection(`Part ${partNum} (${stepName})`);
        await stepRunner(projectRoot);
      }

      logSection('TypeScript 검증');
      await runValidation(projectRoot);

      try {
        const snapshotPath = await createBaseMigrationSnapshot(projectRoot);
        await ensureNextifyMeta(projectRoot, {
          baseMigrationCompleted: true,
          baseMigrationCompletedAt: new Date().toISOString(),
          baseMigrationSnapshotRoot: snapshotPath,
          advancedCompleted: false,
        });
        logSuccess('성능 레포트 비교용 데이터가 생성되었습니다.');
        logStep('생성된 폴더: __nextify_snapshots');
        logStep('이 폴더는 migrate-next report에서 사용됩니다.');
      } catch (snapshotErr) {
        logWarn(`비교용 복사본 생성 실패: ${snapshotErr?.message || snapshotErr}`);
        logStep('성능 레포트에서 기본 마이그레이션 비교 대상이 현재 상태로 대체될 수 있습니다.');
      }
    },
    { writeManifest: false, active: false },
  );

  const { manifest, manifestPath } = finalReviewSession;
  const finalStepLabel = 'step1~step5';

  if (!manifestPath || !Array.isArray(manifest?.changes) || manifest.changes.length === 0) {
    logSuccess(`${finalStepLabel} 완료: 최종 변경 없음`);
    await printBaseMigrationFinalGuide(targetPath, mode);
    return;
  }

  const typeSummary = summarizeChangeTypes(manifest.changes);
  await saveInactiveReviewArchive(manifestPath, manifest);
  logSuccess(`${finalStepLabel} 완료 (변경 ${manifest.changes.length}개)`);
  logStep(`created ${typeSummary.create}  modified ${typeSummary.modify}  deleted ${typeSummary.delete}`);
  logSuccess('기본 마이그레이션 완료.');
  await printBaseMigrationFinalGuide(targetPath, mode);
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
