const fs = require('fs-extra');
const path = require('path');
const { generateText, getNextifyScopeRules } = require('./gemini-client.cjs');
const { sweepAfterAiApply } = require('./post-ai-sweep.cjs');

let _ts = null;
function getTs() {
  if (_ts) return _ts;
  try {
    _ts = require('typescript');
  } catch {
    _ts = null;
  }
  return _ts;
}

/**
 * 파일 확장자에 맞는 ScriptKind 를 고른다.
 * @param {string} relPath
 */
function pickScriptKind(ts, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * 단일 파일 내용에 대한 syntax 진단 개수.
 * 파싱 자체가 불가하면 Number.POSITIVE_INFINITY 를 반환한다.
 * @param {string} relPath
 * @param {string} content
 * @returns {number}
 */
function countSyntaxDiagnostics(relPath, content) {
  const ts = getTs();
  if (!ts) return 0;
  try {
    const kind = pickScriptKind(ts, relPath);
    if (kind === ts.ScriptKind.Unknown) return 0;
    const sf = ts.createSourceFile(
      relPath,
      content,
      ts.ScriptTarget.Latest,
      false,
      kind,
    );
    const diags = sf.parseDiagnostics || [];
    return diags.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

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
 * JSON 문자열 안의 잘못된 이스케이프 시퀀스를 복구한다.
 * Gemini 가 TypeScript/JS 소스(정규식 \w, \d, \s 등)를 content 값에 넣을 때
 * JSON 표준상 유효하지 않은 \X 형태를 그대로 출력해 JSON.parse 가 터지는 경우를 처리.
 * 유효한 이스케이프(" \ / b f n r t u)는 건드리지 않는다.
 * @param {string} t
 * @returns {string}
 */
function repairJsonEscapes(t) {
  // JSON 문자열 토큰 바깥은 건드리지 않고, 문자열 값 내부만 수정한다.
  // 접근: 전체 텍스트를 한 글자씩 읽어 문자열 컨텍스트 내부에서만 치환.
  let result = '';
  let inString = false;
  let i = 0;
  const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
  while (i < t.length) {
    const ch = t[i];
    if (!inString) {
      if (ch === '"') inString = true;
      result += ch;
      i++;
    } else {
      if (ch === '\\') {
        const next = t[i + 1];
        if (next === undefined) {
          result += ch;
          i++;
        } else if (VALID_ESCAPES.has(next)) {
          // 유효한 이스케이프 — 그대로 통과
          result += ch + next;
          i += 2;
          // \uXXXX — 4자리 헥스까지 소비
          if (next === 'u') {
            const hex = t.slice(i, i + 4);
            result += hex;
            i += 4;
          }
        } else {
          // 유효하지 않은 이스케이프 → \\ 로 교체
          result += '\\\\';
          i++;
        }
      } else if (ch === '"') {
        inString = false;
        result += ch;
        i++;
      } else {
        // JSON 문자열 안의 raw 제어문자(0x00–0x1f)를 unicode 이스케이프로
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          result += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          result += ch;
        }
        i++;
      }
    }
  }
  return result;
}

/**
 * @param {string} raw
 * @returns {{ path: string, content: string }[]}
 */
function parseApplyJson(raw) {
  const t = extractFirstJsonObjectText(raw);
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    // 잘못된 이스케이프(\w, \d, \s 등 정규식 이스케이프)를 복구 후 재시도
    data = JSON.parse(repairJsonEscapes(t));
  }
  if (!data || !Array.isArray(data.files)) {
    throw new Error('JSON 형식 오류: { "files": [ { "path", "content" } ] } 가 필요합니다.');
  }
  for (const f of data.files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw new Error('각 files 항목은 path·content 문자열이어야 합니다.');
    }
  }
  return data.files;
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
Use UTF-8. Escape newlines in JSON strings properly.

If the user instruction is unrelated to Nextify or React(Vite) → Next.js migration, return:
{"files":[],"refusal":"Nextify 관련 질문이 아닌 경우 답변하지 않습니다."}

Schema:
{"files":[{"path":"<must match allowed path exactly>","content":"<complete new file source>"}]}

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
 * @param {string} projectRoot
 * @param {{ path: string, content: string }[]} filesFromAi
 * @param {string[]} allowedRelPaths
 * @returns {Promise<{ written: string[], rejected: { path: string, reason: string, before: number, after: number }[] }>}
 */
async function applyAiFilesToDisk(projectRoot, filesFromAi, allowedRelPaths) {
  const written = [];
  const rejected = [];
  for (const f of filesFromAi) {
    const rel = matchAllowedPath(f.path, allowedRelPaths);
    if (!rel) {
      throw new Error(`허용 목록에 없는 path: ${f.path}`);
    }
    const abs = path.join(projectRoot, rel);
    if (!isPathInsideProject(projectRoot, abs)) {
      throw new Error(`경로 검증 실패: ${rel}`);
    }

    // ── 안전망: AI 가 새로 보낸 전체 파일 콘텐츠가 *기존 파일보다*
    //    syntax 진단을 더 많이 만들면 적용을 거부한다.
    //    (전체 파일 재작성이 schema 라 작은 영역만 고치겠다며
    //     멀쩡하던 JSX 짝맞춤을 망가뜨리는 사고를 막기 위함.)
    let beforeDiag = 0;
    try {
      if (await fs.pathExists(abs)) {
        const prev = await fs.readFile(abs, 'utf8');
        beforeDiag = countSyntaxDiagnostics(rel, prev);
      }
    } catch {
      beforeDiag = 0;
    }
    const afterDiag = countSyntaxDiagnostics(rel, f.content);
    if (afterDiag > beforeDiag) {
      rejected.push({
        path: rel,
        reason: 'syntax_regression',
        before: beforeDiag,
        after: afterDiag,
      });
      continue;
    }

    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, f.content, 'utf8');
    written.push(rel);
  }
  return { written, rejected };
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
  const prompt = buildApplyPrompt(question, context, fileEntries);

  const jsonModelOptions = {
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  };

  let raw;
  try {
    raw = await generateText(prompt, { modelOptions: jsonModelOptions });
  } catch {
    raw = await generateText(prompt);
  }

  let patches = [];
  try {
    patches = parseApplyJson(raw);
  } catch {
    // 1차 파싱 실패 시, 스키마를 재강조해 한 번 더 요청
    const retryPrompt = `${prompt}

CRITICAL OUTPUT REQUIREMENT (RETRY):
- Return ONLY a single JSON object.
- The JSON MUST follow exactly this schema:
{"files":[{"path":"<allowed path>","content":"<full file content>"}]}
- Do not include markdown, prose, explanations, or extra keys.`;

    try {
      raw = await generateText(retryPrompt, { modelOptions: jsonModelOptions });
    } catch {
      raw = await generateText(retryPrompt);
    }
    patches = parseApplyJson(raw);
  }

  if (patches.length === 0) {
    const stripped = extractFirstJsonObjectText(raw);
    try {
      const data = JSON.parse(stripped);
      if (data && typeof data.refusal === 'string') {
        throw new Error(data.refusal);
      }
    } catch (error) {
      if (error instanceof Error && error.message) {
        throw error;
      }
    }
  }
  if (patches.length === 0) {
    return [];
  }

  const { written, rejected } = await applyAiFilesToDisk(projectRoot, patches, relPaths);

  if (rejected.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `   🛡️  AI 패치 ${rejected.length}건을 syntax 회귀로 거부 (디스크는 원본 유지):`,
    );
    for (const r of rejected) {
      // eslint-disable-next-line no-console
      console.log(`      - ${r.path} (syntax diag ${r.before} → ${r.after})`);
    }
  }

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
};
