// src/utils/gemini-precheck.cjs
//
// 마이그레이션 시작 직전(=Step1 실행 전) GEMINI_API_KEY 보유 여부를 검증한다.
// step5~7 와 최종 리뷰가 Gemini 호출에 의존하므로, 작업 도중에야 키 부재가 드러나면
// 사용자는 부분적으로 변환된 프로젝트와 함께 멈춰버린다(롤백 비용 발생).
// → 시작 시점에 명시적으로 차단하고, 인라인 입력 + .env.local 저장 옵션을 제공한다.

const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');

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

/**
 * Gemini API 키 형태가 그럴듯한지(=공백/짧은 오타 같은 명백한 오류)만 가볍게 검사.
 * 실제 유효성은 호출 시점에 확인된다.
 */
function isPlausibleGeminiKey(key) {
  if (!key || typeof key !== 'string') return false;
  const t = key.trim();
  if (t.length < 20) return false;
  if (/\s/.test(t)) return false;
  return true;
}

function readGitignore(targetDir) {
  const file = path.join(targetDir, '.gitignore');
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

function ensureEnvLocalIgnored(targetDir) {
  const file = path.join(targetDir, '.gitignore');
  const body = readGitignore(targetDir);
  if (/(^|\n)\.env\.local(\s|$)/.test(body)) return;
  const next = (body && !body.endsWith('\n') ? body + '\n' : body) + '.env.local\n';
  try {
    fs.writeFileSync(file, next, 'utf8');
  } catch {
    // .gitignore 쓰기 실패는 치명적이지 않음 — 경고만 남기고 계속.
  }
}

function persistKeyToEnvLocal(key, targetDir) {
  const file = path.join(targetDir, '.env.local');
  let body = '';
  if (fs.existsSync(file)) {
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      body = '';
    }
    body = body.replace(/^\s*GEMINI_API_KEY\s*=.*$/gm, '').replace(/\n+$/g, '');
    if (body) body += '\n';
  }
  body += `GEMINI_API_KEY=${key}\n`;
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function printEnvSetupGuide() {
  console.log('');
  logWarn('환경 변수 설정 가이드');
  if (process.platform === 'win32') {
    logInfo(chalk.cyan('PowerShell:  $env:GEMINI_API_KEY = "your_api_key"'));
    logInfo(chalk.cyan('cmd:         set GEMINI_API_KEY=your_api_key'));
  } else {
    logInfo(chalk.cyan('export GEMINI_API_KEY=your_api_key'));
  }
  logInfo(chalk.cyan('또는 프로젝트 루트의 .env / .env.local 파일에 한 줄 추가:'));
  logInfo(chalk.cyan('GEMINI_API_KEY=your_api_key'));
  logInfo(chalk.gray('키 발급: https://aistudio.google.com/app/apikey'));
  console.log('');
}

/**
 * 마이그레이션 시작 직전에 호출. 키가 없으면 사용자에게 입력 받아 .env.local 에 저장하거나,
 * 사용자가 거부하면 process.exit(1) 한다.
 *
 * @param {{ projectRoot?: string, assumeYes?: boolean }} [opts]
 * @returns {Promise<{ ok: true, source: 'env'|'prompt' }>}
 */
async function ensureGeminiApiKey(opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const existing = process.env.GEMINI_API_KEY;
  if (existing && isPlausibleGeminiKey(existing)) {
    return { ok: true, source: 'env' };
  }

  console.log('');
  logError('GEMINI_API_KEY가 설정되어 있지 않습니다.');
  logInfo('Nextify 마이그레이션은 step5~step7 와 최종 코드 리뷰 단계에서 Gemini AI 보정/생성을 사용합니다.');
  logInfo('키가 없으면 작업 도중 멈출 수 있어 시작 전에 먼저 확인합니다.');
  logInfo('발급: ' + chalk.cyan('https://aistudio.google.com/app/apikey'));
  console.log('');

  // CI / 비대화형 모드: 키가 없으면 즉시 종료한다 (대화형 입력은 stdin 없으면 hang).
  const nonInteractive =
    opts.assumeYes === true ||
    process.env.NEXTIFY_ASSUME_YES === '1' ||
    !process.stdin.isTTY;
  if (nonInteractive) {
    logError('비대화형 모드에서는 키 입력을 받을 수 없습니다.');
    logInfo('환경 변수를 먼저 설정한 뒤 다시 실행하세요.');
    printEnvSetupGuide();
    process.exit(1);
  }

  const { choice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: '계속 진행하려면 GEMINI_API_KEY 가 필요합니다. 어떻게 설정할까요?',
      choices: [
        { name: '지금 키를 입력해 .env.local 에 저장한다 (추천)', value: 'enter' },
        { name: '직접 환경 변수 설정 후 다시 실행한다 (지금 종료)', value: 'exit' },
      ],
    },
  ]);

  if (choice === 'exit') {
    printEnvSetupGuide();
    process.exit(1);
  }

  const { key } = await inquirer.prompt([
    {
      type: 'password',
      mask: '*',
      name: 'key',
      message: 'GEMINI_API_KEY 를 붙여넣으세요:',
      validate: (v) =>
        isPlausibleGeminiKey(v) || '키 형태가 올바르지 않아 보입니다. 다시 확인하세요.',
    },
  ]);

  const trimmed = key.trim();
  process.env.GEMINI_API_KEY = trimmed;

  try {
    const file = persistKeyToEnvLocal(trimmed, projectRoot);
    ensureEnvLocalIgnored(projectRoot);
    const rel = path.relative(process.cwd(), file) || file;
    logSuccess(`GEMINI_API_KEY를 ${rel}에 저장했습니다. 다음 실행부터 자동 로드됩니다.`);
  } catch (e) {
    logWarn(`.env.local 저장 실패 (${e?.message || e}). 이번 실행 동안 메모리에서만 사용합니다.`);
  }
  console.log('');

  return { ok: true, source: 'prompt' };
}

module.exports = { ensureGeminiApiKey, isPlausibleGeminiKey };
