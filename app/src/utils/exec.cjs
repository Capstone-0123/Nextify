const { spawn } = require('child_process');

/**
 * shell: true + args 배열 조합은 Node 22+ 에서 DEP0190 경고를 낸다.
 * shell 사용 시에는 command + args 를 단일 문자열로 합쳐서 전달해 경고를 억제한다.
 */
function buildShellInvocation(command, args, useShell) {
  if (!useShell || !Array.isArray(args) || args.length === 0) {
    return { cmd: command, cmdArgs: args ?? [] };
  }
  // 공백 포함 토큰은 따옴표로 감싸 shell 이 올바르게 파싱하게 한다.
  const parts = [command, ...args].map((a) =>
    typeof a === 'string' && /\s/.test(a) ? `"${a}"` : String(a),
  );
  return { cmd: parts.join(' '), cmdArgs: [] };
}

function runCommand(command, args, options = {}) {
  const useShell = options.shell ?? true;
  const { cmd, cmdArgs } = buildShellInvocation(command, args, useShell);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: useShell,
      stdio: options.stdio ?? 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}`));
    });
  });
}

function startCommand(command, args, options = {}) {
  const useShell = options.shell ?? true;
  const { cmd, cmdArgs } = buildShellInvocation(command, args, useShell);
  const child = spawn(cmd, cmdArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: useShell,
    stdio: options.stdio ?? 'inherit',
  });

  return child;
}

/**
 * `stdio: 'pipe'` 로 띄운 child 의 stdout/stderr 를 메모리 링버퍼에 보관.
 *
 * 왜 필요한가:
 *   - `next start` 같은 데몬을 'pipe' 로 띄워 두고 호출자가 stdout/stderr 를 한 번도 읽지 않으면
 *     OS 파이프 버퍼가 가득 차서 child 가 write() 에서 멈출 수 있다.
 *   - timeout/조기 종료 같은 사고가 났을 때 사용자가 child 의 마지막 출력을 볼 수 없으면
 *     원인 진단이 불가능해진다.
 *
 * 메모리 사용량:
 *   - 라인 단위 링버퍼 (기본 80줄, 줄당 평균 200B → 약 16KB) 로 무제한 누적 방지.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {{ maxLines?: number }} [options]
 * @returns {{ getRecent(n?: number): string, hasOutput(): boolean, clear(): void }}
 */
function attachOutputCapture(child, options = {}) {
  const maxLines = Math.max(10, Number(options.maxLines) || 80);
  const buffer = [];

  function pushChunk(chunk) {
    if (chunk == null) return;
    let text;
    try {
      text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.length === 0) continue;
      buffer.push(line);
      if (buffer.length > maxLines) buffer.shift();
    }
  }

  child?.stdout?.on?.('data', pushChunk);
  child?.stderr?.on?.('data', pushChunk);
  child?.stdout?.on?.('error', () => {});
  child?.stderr?.on?.('error', () => {});

  return {
    getRecent(n = maxLines) {
      const slice = buffer.slice(-Math.max(1, Number(n) || maxLines));
      return slice.join('\n');
    },
    hasOutput() {
      return buffer.length > 0;
    },
    clear() {
      buffer.length = 0;
    },
  };
}

module.exports = { runCommand, startCommand, attachOutputCapture };

