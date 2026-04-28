const { spawn, spawnSync } = require('child_process');

const GEMINI_PACKAGE = '@google/gemini-cli';

let ensureInFlight = null;

function resolveGeminiCommand() {
  if (process.platform === 'win32') {
    // Windows에서는 npm/yarn 전역 shim(.cmd)이 PATH 탐색에서 누락되는 경우가 있어
    // cmd.exe를 통해 실제 커맨드 해석 결과를 우선 확인합니다.
    const winProbe = spawnSync('cmd.exe', ['/d', '/s', '/c', 'gemini --version'], {
      stdio: 'pipe',
      encoding: 'utf8',
      shell: false,
    });
    if (!winProbe.error && winProbe.status === 0) {
      return 'gemini';
    }
  }

  const candidates = process.platform === 'win32' ? ['gemini.cmd', 'gemini'] : ['gemini'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      stdio: 'pipe',
      encoding: 'utf8',
      shell: false,
    });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

function getInstallAttempts(preferredPm) {
  const normalized = preferredPm === 'bun' ? 'npm' : preferredPm;
  const order = [normalized, 'npm', 'yarn', 'pnpm'].filter(Boolean);
  const unique = [...new Set(order)];
  return unique
    .map((pm) => {
      switch (pm) {
        case 'yarn':
          return { pm, command: `yarn global add ${GEMINI_PACKAGE}` };
        case 'pnpm':
          return { pm, command: `pnpm add -g ${GEMINI_PACKAGE}` };
        default:
          return { pm: 'npm', command: `npm install -g ${GEMINI_PACKAGE}` };
      }
    })
    .filter((attempt, idx, arr) => arr.findIndex((x) => x.command === attempt.command) === idx);
}

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`Command failed: ${command} (code=${code}, signal=${signal || 'none'})`);
      error.code = code;
      error.signal = signal;
      reject(error);
    });
  });
}

async function ensureGeminiCliReady(opts = {}) {
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = (async () => {
    const { pm = 'npm', cwd = process.cwd(), onInfo } = opts;
    const logInfo = typeof onInfo === 'function' ? onInfo : () => {};

    const existing = resolveGeminiCommand();
    if (existing) {
      return { installedNow: false, command: existing, packageName: GEMINI_PACKAGE };
    }

    const attempts = getInstallAttempts(pm);
    let lastError = null;

    for (const attempt of attempts) {
      logInfo(`Gemini CLI가 설치되어 있지 않아 전역 설치를 시도합니다. (${attempt.pm})`);
      logInfo(`실행: ${attempt.command}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await runCommand(attempt.command, cwd);
      } catch (error) {
        lastError = error;
        logInfo(`설치 시도 실패 (${attempt.pm}): ${error.message}`);
        continue;
      }

      const installed = resolveGeminiCommand();
      if (installed) {
        return { installedNow: true, command: installed, packageName: GEMINI_PACKAGE };
      }
      lastError = new Error('설치 명령은 성공했지만 `gemini --version` 검증에 실패했습니다.');
    }

    const error = new Error('Gemini CLI 자동 설치에 실패했습니다.');
    error.code = 'GEMINI_INSTALL_FAILED';
    error.installPackage = GEMINI_PACKAGE;
    error.lastError = lastError;
    throw error;
  })();

  try {
    return await ensureInFlight;
  } finally {
    ensureInFlight = null;
  }
}

module.exports = {
  ensureGeminiCliReady,
  resolveGeminiCommand,
};
