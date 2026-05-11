const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function mergeEnvFileInto(env, absPath) {
  if (!absPath || !fs.existsSync(absPath)) return;
  try {
    const parsed = dotenv.parse(fs.readFileSync(absPath, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== undefined) env[k] = String(v);
    }
  } catch {
    // 손상된 .env 등은 무시
  }
}

/**
 * Gemini CLI 자식 프로세스용 환경: 프로젝트 `.env` / `.env.local`을 셸보다 우선 적용하고,
 * trust / 인증 우선순위를 Nextify 리뷰 흐름에 맞게 맞춥니다.
 *
 * @param {string} [projectRoot] 마이그레이션 대상 프로젝트 루트 (workingDirectory)
 * @returns {NodeJS.ProcessEnv}
 */
function buildGeminiCliSpawnEnv(projectRoot) {
  const env = { ...process.env };

  if (projectRoot) {
    mergeEnvFileInto(env, path.join(projectRoot, '.env'));
    mergeEnvFileInto(env, path.join(projectRoot, '.env.local'));
  }

  const trustOptOut = /^(0|false|no)$/i.test(String(process.env.NEXTIFY_GEMINI_CLI_TRUST_WORKSPACE || ''));
  if (!trustOptOut) {
    env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  }

  // @google/gemini-cli-core getAuthTypeFromEnv(): GCA → Vertex → GEMINI_API_KEY 순.
  // 프로젝트 .env의 GEMINI_API_KEY를 쓰려면 앞선 두 가지가 true로 남아 있으면 안 됩니다.
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  if (apiKey) {
    delete env.GOOGLE_GENAI_USE_GCA;
    delete env.GOOGLE_GENAI_USE_VERTEXAI;
  }

  return env;
}

function getGeminiCliReviewAutoArgs() {
  if (/^(1|true|yes)$/i.test(String(process.env.NEXTIFY_GEMINI_CLI_NO_AUTO_FLAGS || ''))) {
    return [];
  }
  return ['--skip-trust', '--approval-mode=plan'];
}

module.exports = {
  buildGeminiCliSpawnEnv,
  getGeminiCliReviewAutoArgs,
};
