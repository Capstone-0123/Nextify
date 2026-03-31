const fs = require('fs-extra');
const { generateTextStream } = require('./gemini-client.cjs');
const ora = require('ora');
const { spawn } = require('child_process');

async function readUtf8IfExists(absPath) {
  if (!absPath) return '';
  if (!(await fs.pathExists(absPath))) return '';
  return fs.readFile(absPath, 'utf8');
}

function buildChangeSection(change, beforeText, afterText) {
  const header = `FILE: ${change.relativePath}\nTYPE: ${change.type}\n`;
  const beforeBlock = `--- BEFORE ---\n${beforeText}\n`;
  const afterBlock = `--- AFTER ---\n${afterText}\n`;
  return `${header}${beforeBlock}${afterBlock}`;
}

function buildInteractiveSeedPrompt(session, sessionPath) {
  const step = session?.step || 'unknown';
  const changes = Array.isArray(session?.changes) ? session.changes : [];
  const compactChanges = changes
    .map((c, idx) => {
      const id = c?.id || `idx-${idx + 1}`;
      const rel = c?.relativePath || '(unknown)';
      const type = c?.type || 'unknown';
      const before = c?.diffBeforePath || '(none)';
      const after = c?.diffAfterPath || '(none)';
      return `- id=${id}, path=${rel}, type=${type}, diffBeforePath=${before}, diffAfterPath=${after}`;
    })
    .join('\n');

  return [
    'You are a careful senior engineer doing CODE REVIEW for React(Vite) -> Next.js migration.',
    'Respond in Korean.',
    'Review-only mode: never apply edits automatically.',
    `Step: ${step}`,
    `Session file path: ${sessionPath}`,
    `Total changed files: ${changes.length}`,
    'Changed files metadata (all changes, compact):',
    compactChanges || '- (none)',
    '',
    'Evidence mapping guardrails (must follow):',
    '1) When user asks about a file, first normalize their input to exact relativePath and match from the metadata list.',
    "2) If no exact match is found, ask user to confirm/correct the relativePath before reviewing details.",
    '3) Always explain before/after semantics by change type first:',
    '   - create: before is empty placeholder, after is created file.',
    '   - modify: both before and after exist.',
    '   - delete: before is original file, after is empty placeholder.',
    '4) For concrete before-vs-after evaluation, ask user to attach diffBeforePath/diffAfterPath via Gemini CLI @path (or paste content).',
    '5) Do not invent evidence. If diff content is missing, state that and request the files.',
    '',
    'Then continue as an interactive Q&A review chat.',
  ].join('\n');
}

function toSingleLinePromptArg(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .trim();
}

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqPreserveOrder(arr) {
  return [...new Set(arr)];
}

function isUsageLimitReached(text) {
  return /Usage limit reached/i.test(String(text || ''));
}

async function buildAiReviewPromptFromSession(session) {
  const step = session.step || 'unknown';
  const changes = Array.isArray(session.changes) ? session.changes : [];

  const sections = [];
  for (const change of changes) {
    // Snapshot schema
    const beforeReadPath = change.beforeSnapshotPath || change.diffBeforePath || change.beforePath || null;
    const afterReadPath = change.afterPath || change.diffAfterPath || null;

    const [beforeText, afterText] = await Promise.all([
      readUtf8IfExists(beforeReadPath),
      readUtf8IfExists(afterReadPath),
    ]);

    sections.push(buildChangeSection(change, beforeText, afterText));
  }

  return `You are a careful senior engineer doing a CODE REVIEW for a React(Vite) → Next.js migration.

Rules:
- DO NOT output JSON. Output ONLY human-readable review text.
- DO NOT provide patch/apply instructions as executable commands.
- You MAY point out risks, edge cases, and propose what should be changed, but the final output must NOT be an auto-applicable patch.
- If a fix is needed, describe the exact location and what to change conceptually.

Output format (Korean):
1) Step: ${step}
2) Overall risk summary (3-6 bullets)
3) File-by-file review in priority order:
   - [Priority 1] <relative path>
     - Risk:
     - Why:
     - Suggested fix (conceptual, not a patch):
   - [Priority 2] ...

BEGIN CHANGES
${sections.join('\n\n')}
END CHANGES
`;
}

/**
 * Gemini SDK streaming review (no apply).
 * @param {{ sessionPath: string, signal?: AbortSignal, onChunk?: (text: string)=>void }} opts
 */
async function runAiReviewSessionSdkStream(opts) {
  const { sessionPath, signal, onChunk } = opts;
  const session = await fs.readJson(sessionPath);

  if (!Array.isArray(session.changes) || session.changes.length === 0) {
    return { completed: true, skipped: true };
  }

  // 1단계: 컨텍스트(프롬프트) 준비 중
  const stage1Spinner = ora('Loading review context...').start();
  let prompt;
  try {
    prompt = await buildAiReviewPromptFromSession(session);
  } finally {
    stage1Spinner.stop();
  }

  // 2단계: 프롬프트 전송 후 첫 스트림 청크가 올 때까지
  const stage2Spinner = ora('Sending prompt & waiting...').start();
  let firstChunkSeen = false;

  const appendChunk = (t) => {
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      stage2Spinner.stop();
    }
    if (typeof onChunk === 'function') onChunk(t);
  };

  try {
    await generateTextStream(prompt, appendChunk, { signal });
    // 스트리밍이 시작되지 않았더라도 spinner는 정리
    if (!firstChunkSeen) stage2Spinner.stop();
    return { completed: true, skipped: false };
  } catch (err) {
    if (!firstChunkSeen) stage2Spinner.stop();
    // When aborted, we treat it as "stopped" (caller decides next step).
    if (signal?.aborted) {
      return { completed: false, aborted: true, skipped: false };
    }
    throw err;
  }
}

/**
 * Gemini CLI subprocess streaming review (no apply).
 * @param {{
 *  sessionPath: string,
 *  signal?: AbortSignal,
 *  onChunk?: (text: string)=>void,
 *  command?: string,
 *  args?: string[],
 *  mode?: 'interactive'|'interactive-seeded'|'stream',
 *  workingDirectory?: string,
 *  model?: string,
 *  fallbackModels?: string[]|string,
 *  enableUsageLimitFallback?: boolean,
 * }} opts
 */
async function runAiReviewSessionCliStream(opts) {
  const {
    sessionPath,
    signal,
    onChunk,
    command = 'gemini',
    args = [],
    mode = 'interactive-seeded',
    workingDirectory,
    model,
    fallbackModels,
    enableUsageLimitFallback = true,
  } = opts || {};

  const session = await fs.readJson(sessionPath);
  const hasInteractiveTty = Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
  let normalizedMode = mode === 'interactiveSeeded' ? 'interactive-seeded' : mode;
  if (normalizedMode === 'interactive-seeded' && !hasInteractiveTty) {
    // Gemini CLI는 --prompt-interactive를 stdin pipe 환경에서 금지합니다.
    // 자동화/테스트 실행처럼 TTY가 없으면 seed 플래그를 빼고 interactive로 degrade합니다.
    normalizedMode = 'interactive';
    if (typeof onChunk === 'function') {
      onChunk(
        '\n[AI review interactive mode]\n' +
          '- Non-TTY 환경이라 --prompt-interactive 주입을 생략합니다.\n' +
          '- 대신 Gemini CLI 대화형 모드로 실행합니다.\n\n',
      );
    }
  }

  if (!Array.isArray(session.changes) || session.changes.length === 0) {
    return { completed: true, skipped: true };
  }

  let prompt = null;
  let interactiveSeedPrompt = null;
  if (normalizedMode === 'stream') {
    const stage1Spinner = ora('Loading review context...').start();
    try {
      prompt = await buildAiReviewPromptFromSession(session);
    } finally {
      stage1Spinner.stop();
    }
  } else if (normalizedMode === 'interactive-seeded') {
    const stage1Spinner = ora('Preparing interactive review seed...').start();
    try {
      interactiveSeedPrompt = buildInteractiveSeedPrompt(session, sessionPath);
    } finally {
      stage1Spinner.stop();
    }
  }

  const primaryModel = model || process.env.NEXTIFY_GEMINI_CLI_MODEL || 'gemini-2.5-flash-lite';
  const fallbackFromOpts = Array.isArray(fallbackModels) ? fallbackModels : parseCsvList(fallbackModels);
  const fallbackFromEnv = parseCsvList(process.env.NEXTIFY_GEMINI_CLI_FALLBACK_MODELS);
  const defaultFallback = ['gemini-2.5-flash', 'gemini-3-flash-preview'];
  const modelsToTry = uniqPreserveOrder([primaryModel, ...fallbackFromOpts, ...fallbackFromEnv, ...defaultFallback]).filter(Boolean);

  const spawnCandidates =
    process.platform === 'win32'
      ? command === 'gemini'
        ? ['gemini.cmd', 'gemini']
        : [command, 'gemini']
      : [command];

  const waitMessage =
    normalizedMode === 'stream' ? 'Sending prompt to Gemini CLI & waiting...' : 'Launching Gemini CLI interactive session...';

  const attemptWithModel = (modelName) =>
    new Promise((resolve, reject) => {
      let done = false;
      let child;
      let abortHandler;
      let firstChunkSeen = false;
      let usageLimitHit = false;
      const stage2Spinner = ora(waitMessage).start();

      const finish = (result) => {
        if (done) return;
        done = true;
        if (!firstChunkSeen) stage2Spinner.stop();
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        resolve(result);
      };

      const fail = (err) => {
        if (done) return;
        done = true;
        if (!firstChunkSeen) stage2Spinner.stop();
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        reject(err);
      };

      const abortChild = () => {
        if (child && !child.killed) {
          child.kill('SIGINT');
          setTimeout(() => {
            if (child && !child.killed) {
              child.kill();
            }
          }, 400);
        }
      };

      const spawnWithCandidates = (candidates) => {
        for (const candidate of candidates) {
          try {
            const effectiveArgsBase = ['--model', modelName, ...(args || [])];
            const effectiveArgs =
              normalizedMode === 'interactive-seeded' && interactiveSeedPrompt
                ? [...effectiveArgsBase, '--prompt-interactive', toSingleLinePromptArg(interactiveSeedPrompt)]
                : effectiveArgsBase;

            // interactive에서는 TTY가 필요하므로 stdin/stdout/stderr를 전부 inherit로 유지합니다.
            // (stdout/stderr pipe는 TTY 감지를 깨서 gemini가 "No input provided via stdin"으로 종료할 수 있습니다.)
            // usage limit fallback은 exit code(현재 gemini-cli가 usage limit에서 code=42 반환)를 기준으로 처리합니다.
            const stdio = normalizedMode === 'stream' ? ['pipe', 'pipe', 'pipe'] : 'inherit';
            const isWin = process.platform === 'win32';
            if (isWin) {
              // Windows + shell:true 조합에서 긴 인자/특수문자 파싱이 깨질 수 있어
              // cmd.exe 래퍼로 명시 실행합니다.
              child = spawn('cmd.exe', ['/d', '/s', '/c', candidate, ...effectiveArgs], {
                stdio,
                cwd: workingDirectory,
                windowsHide: true,
                shell: false,
              });
            } else {
              child = spawn(candidate, effectiveArgs, {
                stdio,
                cwd: workingDirectory,
                windowsHide: true,
                shell: false,
              });
            }
            return candidate;
          } catch (err) {
            if (err && err.code === 'ENOENT') continue;
            throw err;
          }
        }
        return null;
      };

      const chosen = spawnWithCandidates(spawnCandidates);
      if (!chosen) {
        const guidance = new Error(
          'Gemini CLI command not found. Install Gemini CLI and ensure `gemini` (or `gemini.cmd` on Windows) is available in PATH.',
        );
        guidance.code = 'ENOENT';
        return fail(guidance);
      }

      // Gemini CLI 프로세스 spawn 자체는 성공한 상태입니다.
      // stdout/stderr 청크(첫 output)가 늦게 올 수 있어, 그 때까지 스피너가 계속 도는 문제를 방지합니다.
      firstChunkSeen = true;
      stage2Spinner.stop();

      child.on('error', (err) => {
        if (err && err.code === 'ENOENT') {
          const guidance = new Error(
            'Gemini CLI command not found. Install Gemini CLI and ensure `gemini` (or `gemini.cmd` on Windows) is available in PATH.',
          );
          guidance.code = 'ENOENT';
          return fail(guidance);
        }
        return fail(err);
      });

      const emitChunk = (text) => {
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          stage2Spinner.stop();
        }
        if (typeof onChunk === 'function') onChunk(text);

        if (enableUsageLimitFallback && !usageLimitHit && isUsageLimitReached(text)) {
          usageLimitHit = true;
          abortChild();
          return finish({ completed: false, usageLimit: true, skipped: false, modelTried: modelName });
        }
      };

      child.stdout?.on('data', (buf) => emitChunk(String(buf)));
      child.stderr?.on('data', (buf) => emitChunk(String(buf)));

      child.on('close', (code, closeSignal) => {
        if (signal?.aborted) {
          return finish({ completed: false, aborted: true, skipped: false, modelTried: modelName });
        }
        if (code === 0) {
          return finish({ completed: true, skipped: false, modelTried: modelName });
        }
        if (enableUsageLimitFallback && code === 42) {
          usageLimitHit = true;
        }
        if (usageLimitHit) {
          return finish({ completed: false, usageLimit: true, skipped: false, modelTried: modelName });
        }
        const msg = `Gemini CLI review failed (code=${code}, signal=${closeSignal || 'none'}).`;
        const err = new Error(msg);
        err.code = code;
        err.signal = closeSignal;
        return fail(err);
      });

      abortHandler = () => {
        abortChild();
        finish({ completed: false, aborted: true, skipped: false, modelTried: modelName });
      };
      if (signal) {
        if (signal.aborted) {
          abortHandler();
          return;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      if (normalizedMode === 'stream') {
        child.stdin.write(prompt);
        child.stdin.end();
      } else if (normalizedMode === 'interactive-seeded') {
        if (typeof onChunk === 'function') {
          onChunk(
            '\n[AI review interactive seeded mode]\n' +
              '- Session context has been injected automatically.\n' +
              '- Ask with exact relativePath from the metadata list.\n' +
              '- If match fails, request user confirmation/correction before analysis.\n' +
              '- If needed, request @diffBeforePath and @diffAfterPath (or pasted content) for evidence-based before/after review.\n' +
              '- Continue chatting in Gemini terminal. Press Ctrl+C to stop AI chat.\n\n',
          );
        }
      } else {
        // interactive mode
        if (typeof onChunk === 'function') {
          const changedPaths = session.changes.slice(0, 5).map((c) => c.relativePath).join(', ');
          const hint =
            `\n[AI review interactive mode]\n` +
            `- You can ask Gemini about this step session: ${sessionPath}\n` +
            `- Changed files sample: ${changedPaths || '(none)'}\n` +
            `- Exit Gemini chat with Ctrl+C to continue orchestration wait.\n\n`;
          onChunk(hint);
        }
      }
    });

  let last;
  for (const modelName of modelsToTry) {
    if (signal?.aborted) break;
    // eslint-disable-next-line no-await-in-loop
    last = await attemptWithModel(modelName);
    if (last?.usageLimit) {
      continue;
    }
    return last;
  }
  return last;
}

/**
 * Default review runner: Gemini CLI first, Gemini SDK fallback optional.
 * @param {{ sessionPath: string, signal?: AbortSignal, onChunk?: (text: string)=>void, transport?: 'cli'|'sdk', mode?: 'interactive'|'interactive-seeded'|'stream', workingDirectory?: string }} opts
 */
async function runAiReviewSessionStream(opts) {
  const transport = opts?.transport || 'cli';
  if (transport === 'sdk') {
    return runAiReviewSessionSdkStream(opts);
  }
  if (opts?.mode === 'interactive-seeded') {
    try {
      return await runAiReviewSessionCliStream(opts);
    } catch (err) {
      if (typeof opts?.onChunk === 'function') {
        opts.onChunk(
          '\n[AI review fallback]\n' +
            '- interactive-seeded launch failed. Retrying in plain interactive mode.\n\n',
        );
      }
      return runAiReviewSessionCliStream({ ...opts, mode: 'interactive' });
    }
  }
  return runAiReviewSessionCliStream(opts);
}

module.exports = {
  runAiReviewSessionCliStream,
  runAiReviewSessionSdkStream,
  runAiReviewSessionStream,
};

