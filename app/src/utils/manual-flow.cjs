'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const { runAskApply } = require('./ai-file-apply.cjs');
const {
  detectBuildTool,
  detectLanguage,
  detectPackageManager,
} = require('./project-info.cjs');

/** 사용자 직접처리 후 상위 러너가 감싼 범위의 기계적 마이그레이션을 처음부터 다시 돌리기 위한 신호 */
class MechanicalMigrationRerunError extends Error {
  constructor(message = '기계적 마이그레이션을 다시 실행합니다.') {
    super(message);
    this.name = 'MechanicalMigrationRerunError';
    this.code = 'RERUN_MECHANICAL';
  }
}

function isMechanicalMigrationRerun(err) {
  return !!(
    err &&
    (err.code === 'RERUN_MECHANICAL' || err.name === 'MechanicalMigrationRerunError')
  );
}

/** 무한 재시도 방지 */
const DEFAULT_MAX_MECHANICAL_RERUNS = 10;

// 동일 stop 구간(=discoveryLine + discoverySources)에서 사용자 직접처리(n)를 선택한 횟수
const directRetryCountsByKey = new Map();

function getProjectContext(projectRoot) {
  return {
    buildTool: detectBuildTool(projectRoot),
    language: detectLanguage(projectRoot),
    packageManager: detectPackageManager(projectRoot),
  };
}

/** 충돌·가이드-only 구간: 안내 후 종료 (재실행 유도) — 레거시/특수 경로용 */
function exitMigrationManualFollowup() {
  console.log(
    chalk.yellow('\n위 안내에 따라 수동으로 정리한 뒤, 마이그레이션을 다시 실행하세요.\n')
  );
  process.exit(1);
}

function validateYnStrict(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'y' || s === 'n') return true;
  return 'y 또는 n 을 입력하세요.';
}

function validateYnqStrict(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'y' || s === 'n' || s === 'q') return true;
  return 'y / n / q 중 하나를 입력하세요.';
}

function validateYOnly(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'y') return true;
  return 'y만 입력할 수 있습니다.';
}

/**
 * 사용자 직접처리 안내 (짧은 공통 3단계 + 호출부에서 넘긴 권장 포인트)
 */
function printShortManualGuide(discoveryLine, manualGuideLines = []) {
  console.log(chalk.cyan.bold('\n📋 사용자 직접처리 가이드 (AI 미사용)'));
  console.log(chalk.gray(`  이슈: ${discoveryLine}`));
  console.log(chalk.gray('  1) 위 이슈에 맞게 설정/코드를 직접 수정합니다. (아래 권장 포인트 참고)'));
  console.log(chalk.gray('  2) 파일을 저장합니다.'));
  console.log(
    chalk.gray(
      '  3) 아래에서 y를 입력하면 현재 작업을 재실행합니다.'
    )
  );
  if (manualGuideLines.length > 0) {
    console.log(chalk.yellow('\n  권장 포인트:'));
    manualGuideLines.forEach((line) => console.log(chalk.white(`    - ${line}`)));
  }
}

/** 사용자 직접처리 가이드 출력 직후: y면 계속, q면 exit(1) */
async function askContinueAfterManualGuide() {
  const { ans } = await inquirer.prompt([
    {
      type: 'input',
      name: 'ans',
      message: chalk.yellow('마이그레이션을 계속 진행할까요? (y/q, q면 종료)'),
      default: 'y',
      validate: (input) => {
        const s = String(input ?? '').trim().toLowerCase();
        if (s === '' || s === 'y' || s === 'q') return true;
        return 'y 또는 q 를 입력하세요.';
      },
      filter: (input) => {
        const s = String(input ?? '').trim().toLowerCase();
        return s === '' ? 'y' : s;
      },
    },
  ]);
  if (ans !== 'y') {
    console.log(chalk.yellow('\n종료합니다.\n'));
    process.exit(1);
  }
}

/**
 * Gemini 구간
 * n → 수동 가이드 → 검사 후 진행(y만) → MechanicalMigrationRerunError
 * @param {{ projectRoot: string, discoveryLine: string, discoverySources?: string[], instructionForAi: string, candidateRelPaths: string[], manualGuideLines?: string[] }} opts
 */
async function stopAndOfferGeminiApply(opts) {
  const {
    projectRoot,
    discoveryLine,
    discoverySources = [],
    instructionForAi,
    candidateRelPaths,
    manualGuideLines = [],
  } = opts;

  const existing = [];
  for (const rel of candidateRelPaths) {
    const abs = path.join(projectRoot, rel);
    if (await fs.pathExists(abs)) {
      existing.push(path.normalize(rel));
    }
  }

  console.log(chalk.yellow(`\n${discoveryLine}`));
  if (Array.isArray(discoverySources) && discoverySources.length > 0) {
    const uniq = [...new Set(discoverySources.map((s) => String(s).trim()).filter(Boolean))];
    if (uniq.length > 0) {
      // 파일이 많으면 파일 목록 대신 "상위 디렉토리" 기준으로 요약
      const normalized = uniq.map((p) => String(p).replace(/\\/g, '/'));
      const TOO_MANY_FILES_THRESHOLD = 18;
      if (normalized.length >= TOO_MANY_FILES_THRESHOLD) {
        const countsByDir = new Map();
        for (const p of normalized) {
          const dir = path.posix.dirname(p);
          const key = dir === '.' ? '(root)' : dir;
          countsByDir.set(key, (countsByDir.get(key) || 0) + 1);
        }
        const parts = Array.from(countsByDir.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([dir, count]) => `${dir} (${count}개)`);
        console.log(chalk.gray(`  발견 위치(폴더): ${parts.join(', ')}`));
      } else {
        console.log(chalk.gray(`  발견 위치: ${normalized.join(', ')}`));
      }
    }
  }

  if (existing.length === 0) {
    console.error(chalk.red('\n❌ AI에 넘길 대상 파일이 없습니다. 경로를 확인하세요.\n'));
    process.exit(1);
  }

  const keySources = Array.isArray(discoverySources) ? discoverySources : [];
  const key = `${String(discoveryLine)}|${keySources.map((s) => String(s)).sort().join(',')}`;
  const directCount = directRetryCountsByKey.get(key) || 0;

  let ans;
  if (directCount >= DEFAULT_MAX_MECHANICAL_RERUNS) {
    console.log(
      chalk.red(
        `\n⛔️ 동일 이슈가 반복되었습니다. (사용자 직접처리 ${directCount}회)`
      )
    );
    const prompted = await inquirer.prompt([
      {
        type: 'input',
        name: 'ans',
        message: chalk.yellow('Gemini로 자동 수정할까요? (y=Gemini / n=사용자 직접처리 / q=종료)'),
        validate: validateYnqStrict,
        filter: (input) => String(input ?? '').trim().toLowerCase(),
      },
    ]);
    ans = prompted.ans;
    if (ans === 'q') process.exit(1);
    // y면 즉시 Gemini 실행, n이면 아래 직접처리 흐름
  } else {
    const prompted = await inquirer.prompt([
      {
        type: 'input',
        name: 'ans',
        message: chalk.yellow(
          'Gemini로 관련 파일을 자동 수정할까요? (y/n, n이면 사용자 직접 처리 후 현재 작업부터 재실행)'
        ),
        validate: validateYnStrict,
        filter: (input) => String(input ?? '').trim().toLowerCase(),
      },
    ]);
    ans = prompted.ans;
  }

  if (ans !== 'y') {
    directRetryCountsByKey.set(key, directCount + 1);
    printShortManualGuide(discoveryLine, manualGuideLines);
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continueProbe',
        message: chalk.yellow('검사 후 계속 진행하시겠습니까? (y)'),
        validate: validateYOnly,
        filter: (input) => String(input ?? '').trim().toLowerCase(),
      },
    ]);
    throw new MechanicalMigrationRerunError();
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error(
      chalk.red('\n❌ GEMINI_API_KEY가 없습니다. AI 자동 수정을 사용할 수 없습니다.\n')
    );
    process.exit(1);
  }

  const spinner = ora('Gemini가 코드를 적용하는 중...').start();
  try {
    const written = await runAskApply({
      projectRoot,
      question: instructionForAi,
      filesCsv: existing.join(','),
      context: getProjectContext(projectRoot),
    });
    spinner.stop();
    console.log(chalk.green(`\n✅ Gemini 적용 완료: ${written.join(', ')}`));
    console.log(chalk.green('마이그레이션을 계속 진행합니다.\n'));
  } catch (e) {
    spinner.stop();
    console.error(chalk.red(`\n❌ Gemini 적용 실패: ${e.message}\n`));
    process.exit(1);
  }
}

/**
 * Gemini에 넘길 상대 경로 목록 (루트 설정 + src 하위 소스, 토큰 한도용 개수 제한)
 * @param {string} projectRoot
 * @param {number} maxSourceFiles
 * @returns {Promise<string[]>}
 */
/** src 하위에 포함할 소스 파일 상한 (루트 설정 파일 개수는 별도) */
const DEFAULT_MAX_MIGRATION_SOURCE_FILES = 220;

async function collectMigrationCandidateRelPaths(
  projectRoot,
  maxSourceFiles = DEFAULT_MAX_MIGRATION_SOURCE_FILES
) {
  const rootCandidates = [
    'vite.config.ts',
    'vite.config.mjs',
    'next.config.mjs',
    'next.config.js',
    'tsconfig.json',
    'tsconfig.app.json',
    'package.json',
  ];
  const out = [];
  for (const rel of rootCandidates) {
    if (await fs.pathExists(path.join(projectRoot, rel))) {
      out.push(rel);
    }
  }

  const srcDir = path.join(projectRoot, 'src');
  if (!(await fs.pathExists(srcDir))) {
    return [...new Set(out)];
  }

  const collected = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (collected.length >= maxSourceFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.next', '.git'].includes(e.name)) continue;
        await walk(full);
      } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e.name)) {
        collected.push(path.relative(projectRoot, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(srcDir);
  out.push(...collected.slice(0, maxSourceFiles));
  return [...new Set(out)];
}

module.exports = {
  getProjectContext,
  exitMigrationManualFollowup,
  askContinueAfterManualGuide,
  stopAndOfferGeminiApply,
  collectMigrationCandidateRelPaths,
  DEFAULT_MAX_MIGRATION_SOURCE_FILES,
  MechanicalMigrationRerunError,
  isMechanicalMigrationRerun,
  DEFAULT_MAX_MECHANICAL_RERUNS,
};
