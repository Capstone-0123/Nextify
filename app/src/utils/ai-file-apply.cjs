const fs = require('fs-extra');
const path = require('path');
const { generateText, getNextifyScopeRules } = require('./gemini-client.cjs');

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
 * @param {string} raw
 * @returns {{ path: string, content: string }[]}
 */
function parseApplyJson(raw) {
  const t = stripCodeFences(raw);
  const data = JSON.parse(t);
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
 * @returns {Promise<string[]>}
 */
async function applyAiFilesToDisk(projectRoot, filesFromAi, allowedRelPaths) {
  const written = [];
  for (const f of filesFromAi) {
    const rel = matchAllowedPath(f.path, allowedRelPaths);
    if (!rel) {
      throw new Error(`허용 목록에 없는 path: ${f.path}`);
    }
    const abs = path.join(projectRoot, rel);
    if (!isPathInsideProject(projectRoot, abs)) {
      throw new Error(`경로 검증 실패: ${rel}`);
    }
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, f.content, 'utf8');
    written.push(rel);
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

  const patches = parseApplyJson(raw);
  if (patches.length === 0) {
    const stripped = stripCodeFences(raw);
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
    throw new Error('AI 응답에 적용할 files 항목이 없습니다.');
  }

  return applyAiFilesToDisk(projectRoot, patches, relPaths);
}

module.exports = {
  runAskApply,
  parseApplyJson,
  buildApplyPrompt,
};
