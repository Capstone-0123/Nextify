const fs = require('fs-extra');
const path = require('path');
const { generateText, getNextifyScopeRules } = require('./gemini-client.cjs');
const { sweepAfterAiApply } = require('./post-ai-sweep.cjs');

/** @param {string} p */
function normRelKey(p) {
  return path.normalize(p.trim()).split(path.sep).join('/');
}

/**
 * @param {string} projectRoot
 * @param {string} absolutePath
 */
function isPathInsideProject(projectRoot, absolutePath) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(absolutePath);
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {string} filesCsv
 * @returns {string[]}
 */
function parseAllowedFileList(filesCsv) {
  const t = filesCsv.trim();
  if (!t) return [];
  // 쉼표 구분(권장). PowerShell 등에서 공백만 쓴 경우도 나눔(경로에 공백이 있으면 쉼표로 지정할 것).
  const parts = t.includes(',')
    ? t.split(',')
    : t.split(/\s+/);
  return parts.map((s) => s.trim()).filter(Boolean).map((p) => path.normalize(p));
}

/**
 * @param {string} text
 */
function stripCodeFences(text) {
  let t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/im);
  if (m) return m[1].trim();
  return t;
}

/**
 * 모델이 설명 텍스트를 섞어 보낸 경우를 대비해 첫 JSON 객체 블록을 추출.
 * @param {string} text
 * @returns {string}
 */
function extractFirstJsonObjectText(text) {
  const t = stripCodeFences(text);
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return t.slice(first, last + 1).trim();
  }
  return t;
}

/**
 * 모델 응답 한 항목을 디스크 적용용 형식 `{ path, content }` 로 정규화합니다.
 *
 * 두 형식을 모두 지원합니다 (모델이 둘 중 하나를 선택):
 *  - "content"     : 표준 JSON 문자열로 이스케이프된 전체 소스. 작고 빠름. 1순위.
 *  - "contentB64"  : UTF-8 바이트의 single-line RFC 4648 Base64. 33% 크지만
 *                    제어 문자/이스케이프 실수가 구조적으로 불가능. 위험 파일용.
 *
 * 우선순위: 둘 다 들어오면 `content` 가 우선합니다. (모델이 정상적으로 이스케이프
 * 했다는 신호이므로 더 작은 표현을 신뢰)
 *
 * @param {Record<string, unknown>} entry
 * @returns {{ path: string, content: string }}
 */
function normalizePatchEntry(entry) {
  if (!entry || typeof entry.path !== 'string') {
    throw new Error('각 files 항목에는 path 문자열이 필요합니다.');
  }
  if (typeof entry.content === 'string') {
    return { path: entry.path, content: entry.content };
  }
  if (typeof entry.contentB64 === 'string') {
    const trimmed = entry.contentB64.replace(/\s+/g, '');
    if (trimmed.length === 0) {
      return { path: entry.path, content: '' };
    }
    let buf;
    try {
      buf = Buffer.from(trimmed, 'base64');
    } catch (e) {
      throw new Error(`contentB64 디코딩 실패 (${entry.path}): ${e?.message || e}`);
    }
    return { path: entry.path, content: buf.toString('utf8') };
  }
  throw new Error(
    `각 files 항목에는 path와 함께 "content"(escaped JSON 문자열) 또는 ` +
      `"contentB64"(UTF-8 Base64) 중 하나가 필요합니다. path=${entry.path}`,
  );
}

/**
 * @param {string} raw
 * @returns {{ path: string, content: string }[]}
 */
function parseApplyJson(raw) {
  const t = extractFirstJsonObjectText(raw);
  const data = JSON.parse(t);
  if (!data || !Array.isArray(data.files)) {
    throw new Error('JSON 형식 오류: { "files": [ { "path", "content"|"contentB64" } ] } 가 필요합니다.');
  }
  return data.files.map((f) => normalizePatchEntry(f));
}

/**
 * @param {string} projectRoot
 * @param {string[]} relPaths
 */
async function readProjectFiles(projectRoot, relPaths) {
  const out = [];
  for (const rel of relPaths) {
    const abs = path.join(projectRoot, rel);
    if (!isPathInsideProject(projectRoot, abs)) {
      throw new Error(`허용되지 않은 경로: ${rel}`);
    }
    if (!(await fs.pathExists(abs))) {
      throw new Error(`파일이 없습니다: ${rel}`);
    }
    const content = await fs.readFile(abs, 'utf8');
    out.push({ path: rel, content });
  }
  return out;
}

/**
 * @param {string} question
 * @param {Record<string, string>} context
 * @param {{ path: string, content: string }[]} fileEntries
 */
function buildApplyPrompt(question, context, fileEntries) {
  const allowed = fileEntries.map((f) => f.path).join(', ');
  const filesBlock = fileEntries
    .map((f) => `### FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  return `You are applying file edits for React → Next.js migration.
${getNextifyScopeRules()}
Output MUST be a single JSON object only. No markdown fences, no explanation before or after.

File body encoding — TWO formats are accepted; pick whichever you can produce reliably:
- PREFERRED (smaller, faster) — "content": "<full file source>"
  Standard JSON string. You MUST properly escape EVERY newline as \\n, every tab as \\t, every double-quote as \\", every backslash as \\\\, and every other control character. NEVER place a raw newline inside this string.
- FALLBACK (safer for tricky files) — "contentB64": "<base64(UTF-8 full file)>"
  Single-line RFC 4648 Base64 of the full file bytes. Use this when the file contains characters you cannot reliably escape (mixed quoting, template literals, embedded JSON, etc.).
For each file entry include EXACTLY ONE of "content" or "contentB64" (never both, never neither).

If the user instruction is unrelated to Nextify or React(Vite) → Next.js migration, return:
{"files":[],"refusal":"Nextify 관련 질문이 아닌 경우 답변하지 않습니다."}

Schema (use either form, per-file):
{"files":[
  {"path":"<must match allowed path exactly>","content":"<properly-escaped full source>"},
  {"path":"<must match allowed path exactly>","contentB64":"<single-line base64 of UTF-8 bytes>"}
]}

Allowed paths (the "path" field must be exactly one of these strings): ${allowed}

Project: buildTool=${context.buildTool || 'unknown'}, language=${context.language || 'unknown'}, packageManager=${context.packageManager || 'unknown'}

User instruction:
${question}

Current file contents:
${filesBlock}`;
}

/**
 * @param {string} aiPath
 * @param {string[]} allowedRelPaths
 * @returns {string | null}
 */
function matchAllowedPath(aiPath, allowedRelPaths) {
  const key = normRelKey(aiPath);
  for (const a of allowedRelPaths) {
    if (normRelKey(a) === key) return a;
  }
  return null;
}

/**
 * Gemini 응답을 디스크에 적용합니다.
 * - 화이트리스트(allowedRelPaths)에 없는 path는 throw 하지 않고 skip + warn 합니다.
 *   (Gemini가 가끔 instruction을 넘어선 추론으로 무관 파일을 응답에 포함시켜도
 *    호출자 step의 다른 정상 응답은 그대로 적용되도록.)
 * - 보안 검증(isPathInsideProject) 실패는 그대로 throw 합니다 (실제 위협).
 *
 * @param {string} projectRoot
 * @param {{ path: string, content: string }[]} filesFromAi
 * @param {string[]} allowedRelPaths
 * @returns {Promise<string[]>} 실제로 디스크에 쓰인 상대 경로 목록
 */
async function applyAiFilesToDisk(projectRoot, filesFromAi, allowedRelPaths) {
  const written = [];
  const skipped = [];
  for (const f of filesFromAi) {
    const rel = matchAllowedPath(f.path, allowedRelPaths);
    if (!rel) {
      skipped.push(String(f.path));
      continue;
    }
    const abs = path.join(projectRoot, rel);
    if (!isPathInsideProject(projectRoot, abs)) {
      throw new Error(`경로 검증 실패: ${rel}`);
    }
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, f.content, 'utf8');
    written.push(rel);
  }
  if (skipped.length > 0) {
    console.warn(
      `\n⚠️  Gemini 응답에 화이트리스트 외 ${skipped.length}개 path가 포함되어 있어 건너뜁니다 (정상 path는 그대로 적용됨):`,
    );
    for (const s of skipped) console.warn(`   - ${s}`);
  }
  return written;
}

// Gemini 2.5 Pro/Flash 의 응답 토큰 상한. 1.5 계열 모델은 내부적으로 8k 로 cap 되지만
// 옵션을 지정해도 안전하게 무시됩니다 (상위 호환).
const MAX_OUTPUT_TOKENS = 65536;

/**
 * 단일 배치(파일 묶음)를 Gemini 에 한 번 보내고 결과 patches 를 받아옵니다.
 * 응답이 truncated 이거나 파싱 실패면 `code: 'BATCH_NEEDS_SPLIT'` 에러를 던져
 * 호출자가 배치를 절반으로 나눠 재시도하게 합니다.
 *
 * @param {{
 *   projectRoot: string,
 *   question: string,
 *   context: Record<string, string>,
 *   batch: { path: string, content: string }[],
 * }} args
 * @returns {Promise<{ path: string, content: string }[]>}
 */
async function requestPatchesForBatch({ question, context, batch }) {
  const prompt = buildApplyPrompt(question, context, batch);
  const jsonModelOptions = {
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };

  const callOnce = async (p) => {
    try {
      return await generateText(p, { modelOptions: jsonModelOptions, returnMeta: true });
    } catch (_) {
      const fallback = await generateText(p, { returnMeta: true });
      return fallback;
    }
  };

  const isTruncated = (meta) => {
    const r = (meta && meta.finishReason) || '';
    return r === 'MAX_TOKENS' || r === 'LENGTH';
  };

  const tryParseOrThrow = (text, meta) => {
    try {
      return parseApplyJson(text);
    } catch (parseErr) {
      if (isTruncated(meta)) {
        const e = new Error(
          `모델 응답이 토큰 한도에서 잘렸습니다 (finishReason=${meta.finishReason}, batch=${batch.length}).`,
        );
        e.code = 'BATCH_NEEDS_SPLIT';
        throw e;
      }
      // truncated 아닌데 파싱 실패: 호출자가 retryPrompt 로 한 번 더 시도.
      const e = new Error(parseErr.message || '응답 JSON 파싱 실패');
      e.code = 'PARSE_FAILED';
      throw e;
    }
  };

  let res = await callOnce(prompt);
  let patches;
  try {
    patches = tryParseOrThrow(res.text, res);
  } catch (e) {
    if (e.code === 'BATCH_NEEDS_SPLIT') throw e;
    // PARSE_FAILED → 스키마 재강조 후 1회 재시도.
    // 1차에서 "content" 의 이스케이프 실수가 의심되므로 재시도에서는 안전한
    // contentB64 사용을 우선 권장합니다 (모델이 원하면 content 도 여전히 허용).
    const retryPrompt = `${prompt}

CRITICAL OUTPUT REQUIREMENT (RETRY — previous response failed JSON parsing):
- Return ONLY a single JSON object.
- For each file entry, prefer "contentB64" (single-line base64 of UTF-8 bytes) to avoid escaping mistakes.
- If you choose "content" instead, you MUST escape every \\n, \\t, \\", \\\\, and other control characters per JSON spec.
- Use exactly one of "content" or "contentB64" per file (never both).
- Do not include markdown, prose, explanations, or extra keys.
Allowed schema (per-file, choose one):
{"path":"<allowed path>","content":"<properly-escaped full source>"}
{"path":"<allowed path>","contentB64":"<single-line base64>"}`;
    res = await callOnce(retryPrompt);
    try {
      patches = tryParseOrThrow(res.text, res);
    } catch (e2) {
      if (e2.code === 'BATCH_NEEDS_SPLIT') throw e2;
      // 두 번째 파싱도 실패 — 분할이 가능하면 분할로, 단일 파일이면 진짜 에러.
      if (batch.length > 1) {
        const wrap = new Error(`재시도에서도 파싱 실패. 배치 분할 진행: ${e2.message}`);
        wrap.code = 'BATCH_NEEDS_SPLIT';
        throw wrap;
      }
      throw e2;
    }
  }

  // refusal 단일 객체 처리 (refusal 은 잘림과 무관)
  if (patches.length === 0) {
    const stripped = extractFirstJsonObjectText(res.text);
    try {
      const data = JSON.parse(stripped);
      if (data && typeof data.refusal === 'string') {
        throw new Error(data.refusal);
      }
    } catch (error) {
      if (error instanceof Error && error.message && error.message !== 'Unexpected end of JSON input') {
        throw error;
      }
    }
  }
  return patches;
}

/**
 * 큰 파일 묶음을 한 번에 보내면 응답이 모델 출력 토큰 한도에서 잘려 JSON 파싱이
 * 실패합니다("Expected ',' or ']' after array element …"). 잘린 응답을 그대로
 * 적용하면 부분 적용/오염이 발생하므로, 응답 잘림이나 파싱 실패가 감지되면
 * 입력 배치를 절반으로 나눠 재시도합니다.
 *
 * @param {{
 *   projectRoot: string,
 *   fileEntries: { path: string, content: string }[],
 *   question: string,
 *   context: Record<string, string>,
 *   allowedRelPaths: string[],
 * }} args
 * @returns {Promise<string[]>}
 */
async function applyWithAutoBatching({
  projectRoot,
  fileEntries,
  question,
  context,
  allowedRelPaths,
}) {
  const written = [];
  // queue 는 LIFO 순서로 가공되도록 unshift 로 분할 결과를 다시 넣습니다.
  const queue = [fileEntries];
  while (queue.length > 0) {
    const batch = queue.shift();
    try {
      const patches = await requestPatchesForBatch({ question, context, batch });
      if (patches.length > 0) {
        const w = await applyAiFilesToDisk(projectRoot, patches, allowedRelPaths);
        written.push(...w);
      }
    } catch (e) {
      if (e && e.code === 'BATCH_NEEDS_SPLIT' && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        const left = batch.slice(0, mid);
        const right = batch.slice(mid);
        // eslint-disable-next-line no-console
        console.warn(
          `   ⚠️  Gemini 출력이 토큰 한도에서 잘렸습니다(${batch.length}개). ` +
            `입력 배치를 ${left.length}/${right.length}로 분할해 재시도합니다.`,
        );
        queue.unshift(left, right);
        continue;
      }
      throw e;
    }
  }
  return written;
}

/**
 * Gemini에게 JSON 패치를 요청하고 디스크에 조용히 적용 (--apply 검증용).
 * @param {{ projectRoot: string, question: string, filesCsv: string, context: Record<string, string> }} opts
 * @returns {Promise<string[]>} 적용된 상대 경로 목록
 */
async function runAskApply(opts) {
  const { projectRoot, question, filesCsv, context } = opts;
  const relPaths = parseAllowedFileList(filesCsv);
  if (relPaths.length === 0) {
    throw new Error('--files 에 최소 한 개 경로를 지정하세요.');
  }

  const fileEntries = await readProjectFiles(projectRoot, relPaths);
  const written = await applyWithAutoBatching({
    projectRoot,
    fileEntries,
    question,
    context,
    allowedRelPaths: relPaths,
  });

  // ──────────────────────────────────────────────────────────────────
  // 결정론적 후처리 (Gemini 호출 없음, 토큰 비용 0).
  // - 사용처 없는 `let X = INIT; if (typeof <browserGlobal> ...) { X = ... }` 제거
  // - "Intentional SSR-breaking" 같은 AI 자기-설명 주석 제거
  // 안전망 자체의 실패는 마이그레이션을 막지 않습니다.
  // ──────────────────────────────────────────────────────────────────
  try {
    const { removedTargets } = await sweepAfterAiApply(projectRoot, written);
    if (removedTargets.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `   🧹 사용처 없는 dead-guard ${removedTargets.length}개를 자동 정리했습니다.`
      );
    }
  } catch (sweepErr) {
    // eslint-disable-next-line no-console
    console.log(
      `   ⚠️  AI 후처리 sweep 중 오류(무시 가능): ${sweepErr?.message || sweepErr}`
    );
  }

  return written;
}

module.exports = {
  runAskApply,
  parseApplyJson,
  buildApplyPrompt,
  normalizePatchEntry,
};
