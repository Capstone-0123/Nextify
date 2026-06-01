// src/utils/copy-target-resolver.cjs
//
// `copy` 모드에서 대상 경로를 결정하는 단일 책임 모듈.
//   - 사용자 입력(폴더명/상대경로/절대경로) 정규화
//   - 원본과 동일 경로 차단
//   - 이미 존재하는 폴더에 대해 덮어쓰기/이름 변경/취소 분기
//
// 두 진입점(`migrate-next step1 --output ...`, orchestrator)에서 공유한다.

const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');

function logWarn(msg) {
  console.log(chalk.yellow('⚠ ' + msg));
}

function logError(msg) {
  console.error(chalk.red('✖ ' + msg));
}

function logStep(msg) {
  console.log(chalk.gray('  · ' + msg));
}

/**
 * 사용자가 입력한 경로 문자열을 절대 경로로 정규화.
 * - 절대경로면 그대로
 * - 슬래시/백슬래시 포함 상대경로면 cwd 기준
 * - 폴더명만 입력하면 cwd 의 *부모* 디렉터리 아래로 (현재 프로젝트와 형제 폴더로 생성)
 */
function normalizeTargetPath(rawInput, cwd) {
  const cleaned = String(rawInput || '').trim();
  if (!cleaned) return null;
  const isAbsolute = path.isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned);
  if (isAbsolute) {
    return path.resolve(cleaned);
  }
  if (cleaned.includes('/') || cleaned.includes('\\')) {
    return path.resolve(cwd, cleaned);
  }
  return path.join(path.dirname(cwd), cleaned);
}

function isSamePath(a, b) {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
}

function isDirectoryEmpty(dir) {
  try {
    const items = fs.readdirSync(dir);
    return items.length === 0;
  } catch {
    return false;
  }
}

function defaultRenameSuggestion(original, attempt = 2) {
  const dirname = path.dirname(original);
  const base = path.basename(original);
  const stripped = base.replace(/-(\d+)$/, '');
  return path.join(dirname, `${stripped}-${attempt}`);
}

/**
 * 비대화형 환경에서 호출됐을 때(=stdin TTY 없음) 충돌 시 즉시 에러.
 * CI 가 의도치 않게 사용자 데이터를 덮어쓰지 않도록 하는 안전장치.
 */
function failNonInteractive(targetPath) {
  console.log('');
  logError('복사본 경로가 이미 존재하지만 비대화형 환경이라 확인을 받을 수 없습니다.');
  logStep(targetPath);
  logStep('다른 경로로 다시 시도하거나 사용자 입력이 가능한 터미널에서 실행하세요.');
  process.exit(1);
}

/**
 * @param {{
 *   cwd: string,                // 원본 프로젝트 (Vite) 루트
 *   defaultName?: string,       // 기본 제안 폴더명 (예: `<base>-nextified`)
 *   predefinedPath?: string,    // CLI 옵션으로 이미 받은 경로 (있으면 prompt 생략 시도)
 *   message?: string,           // prompt 메시지
 * }} opts
 * @returns {Promise<string>} 정규화 + 충돌 해결까지 끝낸 절대 targetPath.
 *   기존 폴더 덮어쓰기를 사용자가 승인한 경우, 호출 측 cloneProject 가 충돌 없이 쓸 수
 *   있도록 이 함수가 *직접 폴더를 비워둔다*.
 */
async function resolveCopyTargetPath(opts) {
  const cwd = opts.cwd;
  const message = opts.message || '복사본을 생성할 경로 (폴더명 또는 전체 경로):';
  const parentDir = path.dirname(cwd);
  const baseName = path.basename(cwd);
  const initialDefault =
    opts.defaultName && String(opts.defaultName).trim().length > 0
      ? opts.defaultName
      : path.join(parentDir, `${baseName}-nextified`);

  let pendingInput = opts.predefinedPath ? String(opts.predefinedPath).trim() : null;
  let promptDefault = initialDefault;
  let attempt = 2;

  for (;;) {
    let raw = pendingInput;
    pendingInput = null;
    if (!raw) {
      const ans = await inquirer.prompt([
        { type: 'input', name: 'outputPath', message, default: promptDefault },
      ]);
      raw = ans.outputPath;
    }
    const targetPath = normalizeTargetPath(raw, cwd);
    if (!targetPath) {
      logWarn('경로를 입력해야 합니다.');
      continue;
    }

    // 1) 원본과 동일 경로 → 무한루프 방지: 다른 이름 강제
    if (isSamePath(targetPath, cwd)) {
      logError('대상 경로가 현재 프로젝트와 동일합니다.');
      logStep('복사 모드에서는 새 폴더를 사용해야 합니다.');
      promptDefault = path.join(parentDir, `${baseName}-nextified`);
      continue;
    }

    // 2) 존재 여부 확인
    if (!fs.existsSync(targetPath)) {
      return targetPath;
    }

    let stat;
    try {
      stat = fs.statSync(targetPath);
    } catch (e) {
      logError(`경로 확인 실패: ${e?.message || e}`);
      logStep('다른 경로를 입력하세요.');
      promptDefault = defaultRenameSuggestion(targetPath, attempt++);
      continue;
    }

    // 디렉터리가 비어 있으면 그대로 사용
    if (stat.isDirectory() && isDirectoryEmpty(targetPath)) {
      return targetPath;
    }

    // 3) 충돌 — 사용자에게 선택지 제공
    logError(`복사본 경로가 이미 존재합니다: ${targetPath}`);

    const interactive = !!process.stdin.isTTY && process.env.NEXTIFY_ASSUME_YES !== '1';
    if (!interactive) {
      failNonInteractive(targetPath);
    }

    const choices = [
      {
        name: '다른 이름으로 다시 입력 (추천 — 이전 마이그레이션 결과를 유지합니다)',
        value: 'rename',
      },
      {
        name: '기존 폴더를 삭제하고 다시 생성',
        value: 'overwrite',
      },
    ];

    const { resolution } = await inquirer.prompt([
      {
        type: 'list',
        name: 'resolution',
        message: '어떻게 진행할까요?',
        choices,
      },
    ]);

    if (resolution === 'overwrite') {
      try {
        await fs.remove(targetPath);
      } catch (e) {
        logError(`삭제 실패: ${e?.message || e}`);
        logStep('다른 경로를 입력하세요.');
        promptDefault = defaultRenameSuggestion(targetPath, attempt++);
        continue;
      }
      return targetPath;
    }

    // rename: 자동 후보를 default 로 제시하고 다시 입력 받기
    promptDefault = defaultRenameSuggestion(targetPath, attempt++);
  }
}

module.exports = { resolveCopyTargetPath, normalizeTargetPath };
