// src/utils/gemini-precheck.cjs
//
// 마이그레이션 시작 직전(=Step1 실행 전) GEMINI_API_KEY 보유 여부를 검증한다.
// step5~7 와 최종 리뷰가 Gemini 호출에 의존하므로, 작업 도중에야 키 부재가 드러나면
// 사용자는 부분적으로 변환된 프로젝트와 함께 멈춰버린다(롤백 비용 발생).
// → 시작 시점에 명시적으로 차단하고, .env.local 설정 후 재실행하도록 안내한다.

const chalk = require('chalk');

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

/**
 * 마이그레이션 시작 직전에 호출. 키가 없으면 안내를 출력하고 process.exit(1) 한다.
 *
 * @returns {Promise<{ ok: true, source: 'env' }>}
 */
async function ensureGeminiApiKey() {
  const existing = process.env.GEMINI_API_KEY;
  if (existing && isPlausibleGeminiKey(existing)) {
    return { ok: true, source: 'env' };
  }

  console.error(chalk.red('✖ GEMINI_API_KEY가 설정되어 있지 않습니다.'));
  console.log(
    chalk.white(
      '  · Nextify 마이그레이션은 자동 변환이 어려운 일부 코드 변환과  최종 코드 리뷰 단계에서 Gemini AI 보정/생성을 사용합니다.',
    ),
  );
  console.log(chalk.white('  · 키가 없으면 작업 도중 멈출 수 있습니다.'));
  console.log(chalk.white(' · 계속 진행하려면 GEMINI_API_KEY 를 발급하고 .env.local 에 저장 후 다시 실행하세요.'));
  console.log(chalk.white(' · 발급: https://aistudio.google.com/app/apikey'));
  console.log('');
  process.exit(1);
}

module.exports = { ensureGeminiApiKey, isPlausibleGeminiKey };
