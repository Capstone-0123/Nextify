const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const chalk = require('chalk');
const os = require('os');

const { resolvePackageManagerCommand } = require('../utils/project-info.cjs');
const { runCommand, startCommand, attachOutputCapture } = require('../utils/exec.cjs');
const { cloneProject } = require('../utils/copy.cjs');

const DEFAULT_LIGHTHOUSE_RUNS = 3;
const DEFAULT_LIGHTHOUSE_WARMUP_RUNS = 1;

// 마이그레이션 도구(app/) 루트. 이 파일은 app/src/step7/performance-report.cjs 이므로 두 단계 위가 app/.
const MIGRATOR_APP_ROOT = path.resolve(__dirname, '..', '..');
// lighthouse v12는 Node 18.18 이상을 요구합니다.
const LIGHTHOUSE_MIN_NODE_MAJOR = 18;
// require(esm)이 기본 동작하는 Node 버전 (Node 22.12+).
const REQUIRE_ESM_DEFAULT_MAJOR = 22;
const REQUIRE_ESM_DEFAULT_MINOR = 12;

function parseNodeVersion(versionString = process.version) {
  // process.version 예: 'v20.11.1'
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(versionString);
  if (!match) return { major: 0, minor: 0, patch: 0 };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function assertNodeVersionSupportsLighthouse() {
  const { major } = parseNodeVersion();
  if (major === 0) return; // 알 수 없으면 통과 (이후 단계에서 다른 에러로 잡힘)
  if (major < LIGHTHOUSE_MIN_NODE_MAJOR) {
    throw new Error(
      `Lighthouse 측정은 Node.js ${LIGHTHOUSE_MIN_NODE_MAJOR} 이상이 필요합니다.\n` +
        `현재 Node 버전: ${process.version}\n` +
        `해결: nvm/Volta/winget 등으로 Node LTS(권장: 22.x)를 설치한 뒤 다시 실행하세요.\n` +
        `  - nvm:   nvm install --lts && nvm use --lts\n` +
        `  - winget: winget install OpenJS.NodeJS.LTS\n`
    );
  }
}

/**
 * 마이그레이션 도구의 app/node_modules 안에 lighthouse 패키지가 실제로 풀려 있는지 확인.
 * package-lock.json은 있는데 node_modules가 비어있는 경우(npm install 미수행)도 잡습니다.
 */
async function lighthousePackageInstalled() {
  const pkgPath = path.join(MIGRATOR_APP_ROOT, 'node_modules', 'lighthouse', 'package.json');
  return fs.pathExists(pkgPath);
}

async function chromeLauncherPackageInstalled() {
  const pkgPath = path.join(MIGRATOR_APP_ROOT, 'node_modules', 'chrome-launcher', 'package.json');
  return fs.pathExists(pkgPath);
}

/**
 * app/ 디렉터리에서 npm install 1회 시도 (자동 복구).
 * 실패하면 사용자에게 수동 안내 메시지를 던집니다.
 */
async function tryAutoInstallMigratorDeps() {
  const runtime = resolvePackageManagerCommand(MIGRATOR_APP_ROOT);
  const pm = runtime.pm || 'npm';
  console.log(
    chalk.yellow(
      `\n⚠️  Lighthouse 측정을 위한 의존성(lighthouse, chrome-launcher)을 찾지 못했습니다.\n` +
        `   ${MIGRATOR_APP_ROOT} 에서 ${runtime.displayInstall} 을 자동 실행합니다...`
    )
  );
  try {
    await runCommand(runtime.cmd, [...runtime.argsPrefix, 'install'], { cwd: MIGRATOR_APP_ROOT });
    console.log(chalk.green('   ✔ 자동 설치 완료. 다시 시도합니다.\n'));
    return true;
  } catch (installErr) {
    throw new Error(
      `Lighthouse 의존성 자동 설치에 실패했습니다.\n` +
        `다음 명령을 직접 실행한 뒤 다시 시도하세요.\n` +
        `  cd "${MIGRATOR_APP_ROOT}"\n` +
        `  ${runtime.displayInstall}\n` +
        `(Windows PowerShell에서는 경로에 공백이 있어도 따옴표로 감싸세요)\n` +
        `자동 설치 오류: ${installErr.message}`
    );
  }
}

/**
 * lighthouse(ESM) + chrome-launcher(CJS) 의존성을 안전하게 로드.
 * - lighthouse는 v10+ 부터 ESM-only이므로 dynamic import() 사용.
 * - 모듈을 못 찾으면 1회에 한해 자동 설치 후 재시도.
 * - 실패 케이스별로 정확한 한국어 에러 메시지를 던집니다.
 */
async function loadLighthouseDeps({ allowAutoInstall = true } = {}) {
  if (!(await lighthousePackageInstalled()) || !(await chromeLauncherPackageInstalled())) {
    if (allowAutoInstall) {
      await tryAutoInstallMigratorDeps();
      return loadLighthouseDeps({ allowAutoInstall: false });
    }
    throw new Error(
      `lighthouse 또는 chrome-launcher 패키지가 ${MIGRATOR_APP_ROOT}/node_modules 에 없습니다.\n` +
        `해결: 다음 명령을 실행하세요.\n` +
        `  cd "${MIGRATOR_APP_ROOT}"\n` +
        `  rm -rf node_modules package-lock.json && npm install\n` +
        `(Windows PowerShell: Remove-Item -Recurse -Force node_modules, package-lock.json; npm install)`
    );
  }

  let lighthouseModule;
  let chromeLauncherModule;
  try {
    // lighthouse는 ESM이므로 반드시 dynamic import 사용 (require는 Node<22.12에서 ERR_REQUIRE_ESM).
    lighthouseModule = await import('lighthouse');
  } catch (e) {
    const code = e?.code || '';
    const msg = e?.message || String(e);
    if (code === 'ERR_REQUIRE_ESM' || /ERR_REQUIRE_ESM/.test(msg)) {
      throw new Error(
        `lighthouse는 ESM 전용 패키지인데 현재 환경에서 import에 실패했습니다.\n` +
          `현재 Node 버전: ${process.version}\n` +
          `해결: Node.js ${REQUIRE_ESM_DEFAULT_MAJOR}.${REQUIRE_ESM_DEFAULT_MINOR} 이상(LTS 22.x 권장)으로 업그레이드하세요.\n` +
          `원본 오류: ${msg}`
      );
    }
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /Cannot find (module|package)/.test(msg)
    ) {
      if (allowAutoInstall) {
        await tryAutoInstallMigratorDeps();
        return loadLighthouseDeps({ allowAutoInstall: false });
      }
      throw new Error(
        `lighthouse 모듈을 가져오지 못했습니다.\n` +
          `해결:\n` +
          `  cd "${MIGRATOR_APP_ROOT}"\n` +
          `  npm install\n` +
          `원본 오류: ${msg}`
      );
    }
    throw new Error(
      `lighthouse 로드 중 알 수 없는 오류가 발생했습니다.\n` +
        `현재 Node 버전: ${process.version}\n` +
        `원본 오류: ${msg}`
    );
  }

  try {
    chromeLauncherModule = require('chrome-launcher');
  } catch (e) {
    if (allowAutoInstall) {
      await tryAutoInstallMigratorDeps();
      return loadLighthouseDeps({ allowAutoInstall: false });
    }
    throw new Error(
      `chrome-launcher 모듈을 가져오지 못했습니다.\n` +
        `해결:\n` +
        `  cd "${MIGRATOR_APP_ROOT}"\n` +
        `  npm install chrome-launcher\n` +
        `원본 오류: ${e?.message || String(e)}`
    );
  }

  const lighthouseRunner =
    (typeof lighthouseModule === 'function' && lighthouseModule) ||
    lighthouseModule?.default ||
    lighthouseModule?.lighthouse ||
    null;

  if (typeof lighthouseRunner !== 'function') {
    throw new Error(
      `lighthouse는 로드되었지만 실행 함수를 찾지 못했습니다 (모듈이 깨진 것으로 보입니다).\n` +
        `해결: app/ 의 의존성을 정리하고 다시 설치하세요.\n` +
        `  cd "${MIGRATOR_APP_ROOT}"\n` +
        `  rm -rf node_modules package-lock.json && npm install\n` +
        `(Windows PowerShell: Remove-Item -Recurse -Force node_modules, package-lock.json; npm install)`
    );
  }

  return { lighthouseRunner, chromeLauncher: chromeLauncherModule };
}

/**
 * 시스템에 설치된 Chrome/Chromium/Edge 경로를 찾아 반환. 없으면 null.
 */
function findChromeInstallation(chromeLauncher) {
  try {
    const Launcher = chromeLauncher?.Launcher || chromeLauncher?.default?.Launcher;
    if (Launcher && typeof Launcher.getInstallations === 'function') {
      const installs = Launcher.getInstallations();
      if (Array.isArray(installs) && installs.length > 0) return installs[0];
    }
  } catch {
    // chrome-launcher 내부 탐지 실패도 "Chrome 미설치"로 간주
  }
  return null;
}

function chromeMissingErrorMessage() {
  const platform = process.platform;
  const lines = [
    '시스템에 Chrome (또는 Chromium/Edge)이 설치되어 있지 않거나 자동 탐지에 실패했습니다.',
    'Lighthouse는 헤드리스 Chrome으로 측정하므로 Chrome 계열 브라우저 설치가 필수입니다.',
    '',
    '설치 방법:',
  ];
  if (platform === 'win32') {
    lines.push('  - 다운로드: https://www.google.com/chrome/');
    lines.push('  - 또는 winget: winget install Google.Chrome');
  } else if (platform === 'darwin') {
    lines.push('  - 다운로드: https://www.google.com/chrome/');
    lines.push('  - 또는 Homebrew: brew install --cask google-chrome');
  } else {
    lines.push('  - Ubuntu/Debian: sudo apt-get install -y google-chrome-stable 또는 chromium-browser');
    lines.push('  - Fedora/RHEL: sudo dnf install -y google-chrome-stable 또는 chromium');
  }
  lines.push('');
  lines.push('설치 후에도 같은 에러가 나면 환경변수 CHROME_PATH 에 실행 파일 경로를 지정하세요.');
  lines.push('  예) Windows PowerShell: $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"');
  return lines.join('\n');
}

async function getFreePort(preferred = 4173) {
  function canListen(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
  }

  for (let port = preferred; port < preferred + 200; port++) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await canListen(port);
    if (ok) return port;
  }
  throw new Error('사용 가능한 포트를 찾지 못했습니다.');
}

async function waitForHttpReady(url, options = {}) {
  // 기존 시그니처 호환 (두 번째 인자가 number 인 경우 timeoutMs 로 해석).
  let timeoutMs = 120_000;
  let child = null;
  if (typeof options === 'number') {
    timeoutMs = options;
  } else if (options && typeof options === 'object') {
    if (typeof options.timeoutMs === 'number') timeoutMs = options.timeoutMs;
    if (options.child) child = options.child;
  }

  const start = Date.now();
  // Node 18+ has fetch; Node 16 might not. Use http module fallback.
  const http = require('http');
  const https = require('https');

  const u = new URL(url);
  const candidates = [];
  // Prefer localhost first (often what dev servers bind to)
  if (u.hostname !== 'localhost') {
    const u2 = new URL(url);
    u2.hostname = 'localhost';
    candidates.push(u2.toString());
  }
  candidates.push(url);
  // Also try 127.0.0.1 as fallback
  if (u.hostname !== '127.0.0.1') {
    const u3 = new URL(url);
    u3.hostname = '127.0.0.1';
    candidates.push(u3.toString());
  }

  while (Date.now() - start < timeoutMs) {
    // child 가 조기 종료한 경우 즉시 throw — 죽은 서버를 timeoutMs 동안 헛으로 폴링하지 않게 한다.
    if (child && (child.exitCode != null || child.signalCode)) {
      const err = new Error(
        child.signalCode
          ? `서버 프로세스가 시그널 ${child.signalCode} 로 조기 종료되었습니다 (URL=${url})`
          : `서버 프로세스가 코드 ${child.exitCode} 로 조기 종료되었습니다 (URL=${url})`,
      );
      err.code = 'SERVER_EARLY_EXIT';
      err.exitCode = child.exitCode;
      err.signalCode = child.signalCode;
      throw err;
    }

    try {
      for (const candidateUrl of candidates) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const client = candidateUrl.startsWith('https:') ? https : http;
          const req = client.get(candidateUrl, (res) => {
            res.resume();
            resolve();
          });
          req.on('error', reject);
          req.setTimeout(3000, () => {
            req.destroy(new Error('timeout'));
          });
        });
        return;
      }
      return;
    } catch (e) {
      // keep polling
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1500));
  }
  const err = new Error(`서버 준비 대기 시간 초과: ${url}`);
  err.code = 'SERVER_TIMEOUT';
  throw err;
}

/**
 * 서버 기동 실패(timeout 또는 조기 종료) 시 사용자에게 보여줄 친절 에러 메시지를 합성.
 * - 캡처된 child 의 마지막 출력을 함께 첨부 (가장 큰 진단 가치).
 * - OS 별 수동 점검 명령을 분기.
 * - 마이그레이션 결과물은 보존된다는 점을 명시.
 */
function buildHelpfulServerError(originalErr, info) {
  const { url, port, projectRoot, recentOutput, label, kind } = info;
  const code = originalErr?.code;
  const isTimeout = code === 'SERVER_TIMEOUT' || /시간 초과/.test(originalErr?.message || '');
  const isEarlyExit =
    code === 'SERVER_EARLY_EXIT' || /조기 종료/.test(originalErr?.message || '');

  const lines = [];
  lines.push(`[${label}] ${originalErr?.message || originalErr}`);
  lines.push('');
  lines.push('가능한 원인:');
  if (isEarlyExit) {
    lines.push('  - 서버 프로세스가 즉시 비정상 종료 (가장 흔한 원인)');
    lines.push('    · 빌드 산출물 누락/손상 (.next 또는 dist 폴더)');
    lines.push('    · package.json scripts.start / preview 가 잘못된 명령');
    lines.push('    · node_modules 손상 / 의존성 미설치');
  }
  if (isTimeout) {
    lines.push('  - 서버는 시작했으나 ready 상태에 도달 못 함');
    lines.push('    · 저사양 머신에서 첫 응답이 매우 느린 경우 (120s 초과)');
    lines.push(`    · 서버가 다른 포트로 fallback 떠서 폴링 (${url}) 과 어긋남`);
    lines.push('    · 백신/방화벽이 localhost binding 을 차단');
  }
  lines.push(`  - 포트 ${port} 점유 race (free port 확정 직후 다른 프로세스가 점유)`);
  lines.push('');
  lines.push('[서버 마지막 출력]');
  if (recentOutput && recentOutput.trim().length > 0) {
    lines.push(recentOutput);
  } else {
    lines.push('(없음 — 서버가 stdout/stderr 에 아무것도 출력하지 않았습니다)');
  }
  lines.push('');
  lines.push('수동 점검 가이드:');
  lines.push(`  cd "${projectRoot}"`);
  lines.push('  npm install         # node_modules 누락이면');
  if (kind === 'vite') {
    lines.push('  npm run build       # dist 산출물 다시');
    lines.push(`  npx vite preview --port ${port} --strictPort   # 직접 실행해 에러 확인`);
  } else {
    lines.push('  npm run build       # .next 산출물 다시');
    lines.push(`  npx next start -p ${port}    # 직접 실행해 에러 확인`);
  }
  if (process.platform === 'win32') {
    lines.push(`  netstat -ano | findstr :${port}    # 포트 점유 확인`);
  } else {
    lines.push(`  lsof -iTCP:${port} -sTCP:LISTEN     # 포트 점유 확인`);
  }
  lines.push('');
  lines.push('마이그레이션 결과물은 그대로 보존됩니다. 위 명령으로 직접 원인을 확인 후 다시 시도하세요.');

  const finalErr = new Error(lines.join('\n'));
  finalErr.cause = originalErr;
  finalErr.code = code || 'SERVER_BOOT_FAILED';
  return finalErr;
}

async function directorySizeBytes(dirPath) {
  if (!(await fs.pathExists(dirPath))) return 0;

  const stat = await fs.stat(dirPath);
  if (stat.isFile()) return stat.size;

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  let total = 0;

  for (const entry of entries) {
    const p = path.join(dirPath, entry.name);
    // eslint-disable-next-line no-await-in-loop
    total += await directorySizeBytes(p);
  }
  return total;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

async function readPackageJson(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!(await fs.pathExists(pkgPath))) throw new Error(`package.json 없음: ${projectRoot}`);
  return fs.readJson(pkgPath);
}

async function hasCustomWebpackConfig(projectRoot) {
  const candidates = ['next.config.js', 'next.config.cjs', 'next.config.mjs', 'next.config.ts'];
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (!(await fs.pathExists(p))) continue;
    try {
      const raw = await fs.readFile(p, 'utf8');
      // next config 내 webpack 커스터마이징 흔적만 잡는다.
      if (/\bwebpack\s*[:(]/.test(raw)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

function getPmRuntime(projectRoot) {
  const runtime = resolvePackageManagerCommand(projectRoot);
  const run = (script) => [...runtime.argsPrefix, 'run', script];
  return { ...runtime, run };
}

async function ensureDependenciesInstalled(projectRoot) {
  const nodeModulesPath = path.join(projectRoot, 'node_modules');
  if (await fs.pathExists(nodeModulesPath)) return;

  console.log(chalk.gray(`의존성 설치가 필요합니다: ${projectRoot}`));
  const runtime = resolvePackageManagerCommand(projectRoot);
  await runCommand(runtime.cmd, [...runtime.argsPrefix, 'install'], { cwd: projectRoot });
}

async function runBuild(projectRoot, kind) {
  await ensureDependenciesInstalled(projectRoot);
  const runtime = getPmRuntime(projectRoot);

  if (kind === 'vite') {
    await runCommand(runtime.cmd, runtime.run('build'), { cwd: projectRoot });
    return;
  }
  // Next 16+ 에서 webpack 커스터마이징이 있으면 Turbopack 기본 빌드가 즉시 실패한다.
  // 성능 측정용 빌드는 시작부터 webpack 모드로 강제해 불필요한 실패 로그를 줄인다.
  if (await hasCustomWebpackConfig(projectRoot)) {
    await runCommand(runtime.cmd, [...runtime.run('build'), '--webpack'], {
      cwd: projectRoot,
    });
    return;
  }
  try {
    await runCommand(runtime.cmd, runtime.run('build'), { cwd: projectRoot });
  } catch (err) {
    const msg = String(err?.message || err || '');
    const turbopackWebpackConflict =
      /using Turbopack, with a [`'"]webpack[`'"] config and no [`'"]turbopack[`'"] config/i.test(msg) ||
      /As of Next\.js 16 Turbopack is enabled by default/i.test(msg);
    if (!turbopackWebpackConflict) throw err;

    console.log(
      chalk.yellow(
        '⚠️  Next.js 16 Turbopack/webpack 충돌 감지: 성능 측정을 위해 `next build --webpack`으로 1회 재시도합니다.',
      ),
    );
    await runCommand(runtime.cmd, [...runtime.run('build'), '--webpack'], {
      cwd: projectRoot,
    });
  }
}

async function startServer(projectRoot, kind, port) {
  await ensureDependenciesInstalled(projectRoot);
  const runtime = getPmRuntime(projectRoot);
  const pm = runtime.pm;

  const pkg = await readPackageJson(projectRoot);
  const scripts = pkg.scripts || {};

  // 호스트/포트를 env 로 함께 강제: 일부 PM/OS 에서 `-p` 인자가 next 까지 도달하지 않는 케이스가 있어
  // PORT 환경변수와 -p 인자 두 경로를 같이 줘서 일치를 보장. HOSTNAME=127.0.0.1 로 고정해
  // Windows IPv6 우선/0.0.0.0 binding 미스매치도 방지한다.
  const childEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
  };

  let child;

  if (kind === 'vite') {
    if (scripts.preview) {
      const args =
        pm === 'yarn'
          ? [...runtime.run('preview'), '--port', String(port), '--strictPort']
          : [...runtime.run('preview'), '--', '--port', String(port), '--strictPort'];
      child = startCommand(runtime.cmd, args, { cwd: projectRoot, stdio: 'pipe', env: childEnv });
    } else {
      // fallback: try npx vite preview
      child = startCommand(
        'npx',
        ['vite', 'preview', '--port', String(port), '--strictPort'],
        { cwd: projectRoot, stdio: 'pipe', env: childEnv },
      );
    }
  } else if (scripts.start) {
    // next
    child = startCommand(runtime.cmd, [...runtime.run('start'), '--', '-p', String(port)], {
      cwd: projectRoot,
      stdio: 'pipe',
      env: childEnv,
    });
  } else {
    child = startCommand('npx', ['next', 'start', '-p', String(port)], {
      cwd: projectRoot,
      stdio: 'pipe',
      env: childEnv,
    });
  }

  // stdout/stderr 캡처 부착:
  //   1) 'pipe' 로 띄워두고 호출자가 한 번도 읽지 않으면 OS 파이프 버퍼가 가득 차서 child 가
  //      writev() 에서 멈출 수 있다 — 우리 케이스의 가장 의심스러운 hang 원인.
  //   2) 사고(timeout/조기 종료) 시 마지막 출력을 사용자에게 그대로 보여줘 진단을 가능하게 한다.
  child.__capture = attachOutputCapture(child, { maxLines: 80 });

  return child;
}

async function runLighthouseOnce(url) {
  // 1) Node 버전 사전 체크 (lighthouse v12는 Node 18+ 필요)
  assertNodeVersionSupportsLighthouse();

  // 2) lighthouse(ESM) + chrome-launcher 로드 (필요 시 자동 npm install 1회 시도)
  const { lighthouseRunner, chromeLauncher } = await loadLighthouseDeps();

  // 3) Chrome 사전 탐지
  const chromePath = findChromeInstallation(chromeLauncher);
  if (!chromePath) {
    throw new Error(chromeMissingErrorMessage());
  }

  const baseTmp = path.join(os.tmpdir(), 'nextify-lighthouse');
  await fs.ensureDir(baseTmp);
  const userDataDir = await fs.mkdtemp(path.join(baseTmp, 'profile-'));

  // 4) Chrome 실행 (실패하면 별도 가이드)
  let chrome;
  try {
    chrome = await chromeLauncher.launch({
      chromePath,
      chromeFlags: [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${userDataDir}`,
      ],
    });
  } catch (launchErr) {
    throw new Error(
      `Chrome 헤드리스 실행에 실패했습니다.\n` +
        `시도한 Chrome 경로: ${chromePath}\n` +
        `현재 OS: ${process.platform}\n` +
        `해결 가이드:\n` +
        `  - 다른 Chrome 인스턴스가 실행 중이면 종료한 뒤 다시 시도하세요.\n` +
        `  - 백신/회사 보안 정책이 Chrome 헤드리스를 차단하는지 확인하세요.\n` +
        `  - Linux 서버라면 의존 라이브러리(libnss3, libgbm1 등) 설치 여부를 확인하세요.\n` +
        `원본 오류: ${launchErr?.message || String(launchErr)}`
    );
  }
  try {
    const options = {
      port: chrome.port,
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'seo'],
    };
    const runnerResult = await lighthouseRunner(url, options);
    const lhr = runnerResult.lhr;

    const fcpMs = lhr.audits['first-contentful-paint']?.numericValue ?? null;
    const lcpMs = lhr.audits['largest-contentful-paint']?.numericValue ?? null;
    const seoScore = lhr.categories?.seo?.score ?? null;
    const perfScore = lhr.categories?.performance?.score ?? null;

    return {
      fcpMs,
      lcpMs,
      seoScore: seoScore == null ? null : Math.round(seoScore * 100),
      perfScore: perfScore == null ? null : Math.round(perfScore * 100),
      fetchedAt: new Date().toISOString(),
      finalUrl: lhr.finalUrl,
    };
  } finally {
    try {
      await chrome.kill();
    } catch (e) {
      // Windows에서 임시 디렉토리 정리 시 EPERM가 간헐적으로 발생할 수 있어 무시합니다.
    }
    try {
      await fs.remove(userDataDir);
    } catch (e) {
      // ignore
    }
  }
}

function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function standardDeviation(values) {
  if (!values.length) return null;
  if (values.length === 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function summarizeNumeric(values) {
  if (!values.length) {
    return {
      count: 0,
      median: null,
      mean: null,
      min: null,
      max: null,
      stddev: null,
    };
  }

  return {
    count: values.length,
    median: median(values),
    mean: mean(values),
    min: Math.min(...values),
    max: Math.max(...values),
    stddev: standardDeviation(values),
  };
}

function aggregateLighthouseRuns(runs) {
  const fcpValues = runs.map((run) => run.fcpMs).filter((v) => v != null);
  const lcpValues = runs.map((run) => run.lcpMs).filter((v) => v != null);
  const seoValues = runs.map((run) => run.seoScore).filter((v) => v != null);
  const perfValues = runs.map((run) => run.perfScore).filter((v) => v != null);

  return {
    fcpMs: summarizeNumeric(fcpValues),
    lcpMs: summarizeNumeric(lcpValues),
    seoScore: summarizeNumeric(seoValues),
    perfScore: summarizeNumeric(perfValues),
  };
}

async function runLighthouseSeries(url, { runs = DEFAULT_LIGHTHOUSE_RUNS, warmupRuns = DEFAULT_LIGHTHOUSE_WARMUP_RUNS } = {}) {
  const warmups = Math.max(0, Number(warmupRuns) || 0);
  const measuredRuns = Math.max(1, Number(runs) || 1);
  const totalRuns = warmups + measuredRuns;
  const collectedRuns = [];
  let lastFinalUrl = url;

  for (let i = 0; i < totalRuns; i++) {
    const isWarmup = i < warmups;
    const runIndex = i + 1;
    console.log(
      chalk.gray(
        `[Lighthouse] ${isWarmup ? 'warmup' : 'measure'} ${runIndex}/${totalRuns} - ${url}`
      )
    );
    // eslint-disable-next-line no-await-in-loop
    const result = await runLighthouseOnce(url);
    lastFinalUrl = result.finalUrl || lastFinalUrl;

    if (!isWarmup) {
      collectedRuns.push({
        run: collectedRuns.length + 1,
        ...result,
      });
    }
  }

  return {
    runs: collectedRuns,
    summary: aggregateLighthouseRuns(collectedRuns),
    finalUrl: lastFinalUrl,
    measuredRuns,
    warmups,
  };
}

async function waitForProcessExit(child, timeoutMs = 5000) {
  if (!child || !child.pid) return;
  if (child.exitCode != null) return;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

async function stopServerProcess(server) {
  if (!server || !server.pid) return;
  if (server.exitCode != null) return;

  try {
    if (process.platform === 'win32') {
      await runCommand('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      await waitForProcessExit(server, 2000);
      return;
    }

    server.kill('SIGTERM');
    await waitForProcessExit(server, 3000);
    if (server.exitCode == null) {
      server.kill('SIGKILL');
      await waitForProcessExit(server, 2000);
    }
  } catch (e) {
    // 이미 종료된 프로세스 등의 케이스는 무시
  }
}

async function measureTarget({ label, projectRoot, kind, lighthouseRuns, warmupRuns }) {
  console.log(chalk.gray(`\n[측정] ${label}`));
  await runBuild(projectRoot, kind);

  const port = await getFreePort(kind === 'vite' ? 4173 : 3000);
  const url = `http://localhost:${port}/`;
  const server = await startServer(projectRoot, kind, port);

  try {
    try {
      // child 핸들을 함께 넘겨 조기 종료 시 즉시 빠져나가게 한다 (헛 폴링 회피).
      await waitForHttpReady(url, { child: server });
    } catch (waitErr) {
      const recent = server?.__capture?.getRecent?.(60) || '';
      throw buildHelpfulServerError(waitErr, {
        url,
        port,
        projectRoot,
        recentOutput: recent,
        label,
        kind,
      });
    }
    const lighthouseResult = await runLighthouseSeries(url, {
      runs: lighthouseRuns,
      warmupRuns,
    });

    const sizeDir =
      kind === 'vite'
        ? path.join(projectRoot, 'dist')
        : path.join(projectRoot, '.next', 'static');
    const bytes = await directorySizeBytes(sizeDir);

    return {
      label,
      kind,
      projectRoot,
      url,
      lighthouse: lighthouseResult,
      jsPayload: {
        directory: sizeDir,
        bytes,
        human: formatBytes(bytes),
      },
    };
  } finally {
    await stopServerProcess(server);
  }
}

function formatMsToSeconds(ms) {
  if (ms == null) return 'N/A';
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatRangeSeconds(metricSummary) {
  if (!metricSummary || metricSummary.min == null || metricSummary.max == null) return 'N/A';
  return `${(metricSummary.min / 1000).toFixed(2)} ~ ${(metricSummary.max / 1000).toFixed(2)} s`;
}

function formatStddevSeconds(metricSummary) {
  if (!metricSummary || metricSummary.stddev == null) return 'N/A';
  return `${(metricSummary.stddev / 1000).toFixed(2)} s`;
}

function formatStddevScore(metricSummary) {
  if (!metricSummary || metricSummary.stddev == null) return 'N/A';
  return `${metricSummary.stddev.toFixed(2)}`;
}

function formatScore(value) {
  if (value == null) return 'N/A';
  return `${Math.round(value)}/100`;
}

function formatScoreRange(metricSummary) {
  if (!metricSummary || metricSummary.min == null || metricSummary.max == null) return 'N/A';
  return `${Math.round(metricSummary.min)} ~ ${Math.round(metricSummary.max)}`;
}

function pickSummaryRow(target) {
  const summary = target.lighthouse?.summary || {};
  return {
    label: target.label,
    fcp: formatMsToSeconds(summary.fcpMs?.median),
    fcpStability: formatStddevSeconds(summary.fcpMs),
    lcp: formatMsToSeconds(summary.lcpMs?.median),
    lcpStability: formatStddevSeconds(summary.lcpMs),
    seo: formatScore(summary.seoScore?.median),
    seoStability: formatStddevScore(summary.seoScore),
    js: target.jsPayload?.human ?? 'N/A',
  };
}

function renderRunBreakdown(runs, metricKey, formatter) {
  if (!runs || runs.length === 0) return 'N/A';
  return runs
    .map((run, i) => `${i + 1}:${formatter(run[metricKey])}`)
    .join(', ');
}

function renderTargetDetail(target) {
  const summary = target?.lighthouse?.summary || {};
  const sizeLabel = target.kind === 'vite' ? 'Dist size dir' : 'Static size dir';
  return `### ${target.label}

- Root: \`${target.projectRoot}\`
- URL: \`${target.url}\`
- ${sizeLabel}: \`${target.jsPayload?.directory || 'N/A'}\` (${target.jsPayload?.human || 'N/A'})
- Lighthouse finalUrl: \`${target.lighthouse?.finalUrl || 'N/A'}\`
- FCP median/mean/stddev: ${formatMsToSeconds(summary.fcpMs?.median)} / ${formatMsToSeconds(summary.fcpMs?.mean)} / ${formatStddevSeconds(summary.fcpMs)} (range: ${formatRangeSeconds(summary.fcpMs)})
- LCP median/mean/stddev: ${formatMsToSeconds(summary.lcpMs?.median)} / ${formatMsToSeconds(summary.lcpMs?.mean)} / ${formatStddevSeconds(summary.lcpMs)} (range: ${formatRangeSeconds(summary.lcpMs)})
- SEO median/mean/stddev: ${formatScore(summary.seoScore?.median)} / ${formatScore(summary.seoScore?.mean)} / ${formatStddevScore(summary.seoScore)} (range: ${formatScoreRange(summary.seoScore)})
- FCP run-by-run: ${renderRunBreakdown(target.lighthouse?.runs, 'fcpMs', (v) => formatMsToSeconds(v))}
- LCP run-by-run: ${renderRunBreakdown(target.lighthouse?.runs, 'lcpMs', (v) => formatMsToSeconds(v))}
`;
}

function renderMarkdownReport({ targets, failures }) {
  const rows = targets.map((t) => pickSummaryRow(t));
  const summaryRows = rows.length
    ? rows
        .map(
          (row) =>
            `| ${row.label} | ${row.fcp} | ${row.fcpStability} | ${row.lcp} | ${row.lcpStability} | ${row.seo} | ${row.seoStability} | ${row.js} |`,
        )
        .join('\n')
    : '| (no successful targets) | N/A | N/A | N/A | N/A | N/A | N/A | N/A |';
  const detailSection = targets.length
    ? targets.map((target) => renderTargetDetail(target)).join('\n')
    : '- 성공적으로 측정된 타깃이 없습니다.';
  const failureSection =
    Array.isArray(failures) && failures.length > 0
      ? failures
          .map((item) => `- ${item.label}: ${item.errorMessage}`)
          .join('\n')
      : '- 없음';
  const now = new Date().toISOString();
  const measurementConfig = targets[0]?.lighthouse || {};
  const measuredRuns = measurementConfig.measuredRuns ?? DEFAULT_LIGHTHOUSE_RUNS;
  const warmupRuns = measurementConfig.warmups ?? DEFAULT_LIGHTHOUSE_WARMUP_RUNS;

  return `# Nextify Performance Report

생성 시각: ${now}

## 비교 대상

- Vite + React (원본)
- Next.js (1~6단계, 성능 최적화 미적용)
- Next.js (7단계 적용, 성능 최적화 적용)

## 측정 지표

- FCP (First Contentful Paint, median)
- LCP (Largest Contentful Paint, median)
- SEO Score (Lighthouse, median)
- FCP/LCP/SEO 표준편차(작을수록 안정적)
- Total JS payload size (폴더 용량)

## 측정 설정

- Lighthouse warmup runs: ${warmupRuns}
- Lighthouse measured runs: ${measuredRuns}
- Summary 기준: median (표준편차/범위 함께 표시)

## 결과 요약 (${targets.length}-way, successful targets)

| Target | FCP (median) | FCP σ | LCP (median) | LCP σ | SEO (median) | SEO σ | Total JS payload size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${summaryRows}

## 측정 상세

${detailSection}

## 실패 항목

${failureSection}
`;
}

async function ensureNextifyMeta(projectRoot, metaPatch) {
  const dir = path.join(projectRoot, '.nextify');
  const metaPath = path.join(dir, 'meta.json');
  await fs.ensureDir(dir);

  let meta = {};
  if (await fs.pathExists(metaPath)) {
    try {
      meta = await fs.readJson(metaPath);
    } catch (e) {
      meta = {};
    }
  }

  const merged = { ...meta, ...metaPatch };
  await fs.writeJson(metaPath, merged, { spaces: 2 });
  return merged;
}

async function readNextifyMeta(projectRoot) {
  const metaPath = path.join(projectRoot, '.nextify', 'meta.json');
  if (!(await fs.pathExists(metaPath))) return null;
  try {
    return await fs.readJson(metaPath);
  } catch (e) {
    return null;
  }
}

async function createPreStep7Snapshot(projectRoot) {
  // IMPORTANT: 스냅샷을 프로젝트 "밖"에 둬야 fs-extra가 "자기 하위로 복사"를 막지 않습니다.
  const resolvedProjectRoot = path.resolve(projectRoot);
  const parentDir = path.dirname(resolvedProjectRoot);
  const projectName = path.basename(resolvedProjectRoot);

  const snapshotRoot = path.join(parentDir, `${projectName}__nextify_snapshots`, 'pre-step7');
  if (await fs.pathExists(snapshotRoot)) {
    return snapshotRoot;
  }
  await fs.ensureDir(path.dirname(snapshotRoot));
  await cloneProject(projectRoot, snapshotRoot);
  await ensureNextifyMeta(projectRoot, {
    preStep7SnapshotRoot: snapshotRoot,
  });
  return snapshotRoot;
}

async function generatePerformanceReport({
  projectRoot,
  baselineViteRoot,
  preStep7Root,
  outputMarkdownPath,
  lighthouseRuns,
  warmupRuns,
}) {
  const meta = await readNextifyMeta(projectRoot);
  const baselineFromMeta = meta?.sourceViteProjectRoot;

  const viteRootResolved = baselineViteRoot || baselineFromMeta;
  if (!viteRootResolved) {
    throw new Error(
      'Vite 원본 경로를 찾지 못했습니다. step1을 copy 모드로 실행했는지 확인하거나, step7 실행 시 --baseline <viteRoot> 옵션을 주세요.'
    );
  }

  const preRootResolved = preStep7Root || (await createPreStep7Snapshot(projectRoot));

  const targets = [];
  const failures = [];
  const measurePlans = [
    { label: 'Vite+React (baseline)', projectRoot: viteRootResolved, kind: 'vite' },
    { label: 'Next.js (step1~6)', projectRoot: preRootResolved, kind: 'next' },
    { label: 'Next.js (step1~7)', projectRoot, kind: 'next' },
  ];

  for (const plan of measurePlans) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const measured = await measureTarget({
        label: plan.label,
        projectRoot: plan.projectRoot,
        kind: plan.kind,
        lighthouseRuns,
        warmupRuns,
      });
      targets.push(measured);
    } catch (error) {
      failures.push({
        label: plan.label,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      console.log(chalk.yellow(`⚠️  [레포트] ${plan.label} 측정 실패: ${failures[failures.length - 1].errorMessage}`));
    }
  }

  const md = renderMarkdownReport({ targets, failures });
  await fs.writeFile(outputMarkdownPath, md, 'utf-8');

  await ensureNextifyMeta(projectRoot, {
    lastPerformanceReport: {
      outputMarkdownPath,
      generatedAt: new Date().toISOString(),
      baselineViteRoot: viteRootResolved,
      preStep7Root: preRootResolved,
      successfulTargets: targets.length,
      failedTargets: failures.length,
    },
  });

  if (failures.length > 0) {
    console.log(chalk.yellow(`\n⚠️  부분 성능 레포트 생성 완료: ${outputMarkdownPath}`));
    console.log(chalk.gray(`   - 성공: ${targets.length}, 실패: ${failures.length}\n`));
    return;
  }

  console.log(chalk.green(`\n✅ 성능 레포트 생성 완료: ${outputMarkdownPath}\n`));
}

module.exports = {
  generatePerformanceReport,
  createPreStep7Snapshot,
  ensureNextifyMeta,
};

