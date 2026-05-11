const { GoogleGenerativeAI } = require('@google/generative-ai');

let geminiClient = null;

function getNextifyScopeRules() {
  return [
    'You only answer questions that are directly related to Nextify or React(Vite) to Next.js migration.',
    'If the user asks something unrelated to Nextify or migration, refuse briefly in Korean.',
    'Use this exact refusal sentence for off-topic requests: "Nextify 관련 질문이 아닌 경우 답변하지 않습니다."',
  ].join('\n');
}

/**
 * 사용 가능한 모델 목록 조회
 * @param {string} apiKey - Google Gemini API 키
 * @returns {Promise<Array>} 사용 가능한 모델 목록
 */
async function listAvailableModels(apiKey) {
  try {
    const https = require('https');
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
    
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.models || []);
          } catch (e) {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });
  } catch (error) {
    return [];
  }
}

/**
 * Gemini API 클라이언트 초기화
 * @param {string} apiKey - Google Gemini API 키
 * @returns {GoogleGenerativeAI} Gemini 클라이언트 인스턴스
 */
function initGeminiClient(apiKey) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.');
  }
  
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(apiKey);
  }
  
  return geminiClient;
}

/**
 * Gemini API를 사용하여 텍스트 생성
 * @param {string} prompt - 사용자 프롬프트
 * @param {Object} options - 추가 옵션
 * @returns {Promise<string>} 생성된 텍스트
 */
async function generateText(prompt, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 환경 변수를 설정해주세요.\n예: export GEMINI_API_KEY=your_api_key');
  }
  
  const client = initGeminiClient(apiKey);
  
  // 먼저 사용 가능한 모델 목록 조회
  let availableModelNames = [];
  try {
    const availableModels = await listAvailableModels(apiKey);
    availableModelNames = availableModels.map(m => m.name?.split('/').pop() || m.name).filter(Boolean);
  } catch (listError) {
    // 모델 목록 조회 실패 시 기본 모델 사용
  }
  
  // 기본 모델 목록 — v1beta endpoint 에서 살아있는 모델만 박아둡니다.
  //
  // 주의:
  //   - GoogleGenerativeAI SDK 는 기본적으로 v1beta 로 generateContent 를 호출합니다.
  //   - 그래서 v1 에는 있어도 v1beta 에는 없는 모델(예: gemini-1.5-pro)은 404로 떨어집니다.
  //   - 존재하지 않는 미래 버전(gemini-3.*, 4.*)을 박아두면 첫 N개가 모두 404로 시간을
  //     낭비하고, 마지막 모델의 404가 lastError 로 남아 진짜 실패 원인이 가려집니다.
  //   - listAvailableModels() 가 동적으로 가져온 모델은 availableModelNames 로 우선 시도합니다.
  const defaultModels = [
    options.model,
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ].filter(Boolean);
  
  // 사용 가능한 모델 목록과 기본 모델 목록을 합치고 중복 제거
  const modelsToTry = availableModelNames.length > 0 
    ? [...new Set([options.model, ...availableModelNames, ...defaultModels])].filter(Boolean)
    : defaultModels;
  
  // 각 모델별 실제 에러를 누적합니다. lastError 만 노출하면 마지막 시도(노이즈)의 404 같은
  // 부차적 에러만 보여서 quota/rate-limit/auth 같은 진짜 원인이 가려집니다.
  const perModelErrors = [];
  
  for (const modelName of modelsToTry) {
    try {
      const model = client.getGenerativeModel({ 
        model: modelName,
        ...options.modelOptions 
      });
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      if (options.returnMeta) {
        // finishReason 은 응답이 잘렸는지(=MAX_TOKENS) 식별하기 위해 호출자에게 노출합니다.
        // 잘린 응답을 그대로 JSON.parse 하면 잘못된 위치에서 throw 되어 진짜 원인이 가려집니다.
        let finishReason = null;
        try {
          finishReason = response.candidates?.[0]?.finishReason || null;
        } catch (_) {
          finishReason = null;
        }
        return { text, finishReason, model: modelName };
      }
      return text;
    } catch (error) {
      perModelErrors.push({ model: modelName, message: error?.message || String(error) });
      // 다음 모델 시도
      continue;
    }
  }
  
  // 모든 모델 실패 — 진짜 원인을 그룹핑해서 노출.
  // 같은 메시지로 묶인 에러가 많다면 quota/auth/네트워크 같은 공통 원인일 가능성이 높습니다.
  const grouped = new Map();
  for (const e of perModelErrors) {
    const key = (e.message || '').slice(0, 200);
    const arr = grouped.get(key) || [];
    arr.push(e.model);
    grouped.set(key, arr);
  }
  const groupedLines = [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([msg, models]) => `  - [${models.length}개 모델] ${models.slice(0, 3).join(', ')}${models.length > 3 ? ' …' : ''}\n    → ${msg}`);
  
  const errorMsg =
    `모든 모델 시도 실패 (${modelsToTry.length}개).\n` +
    `시도한 모델: ${modelsToTry.slice(0, 6).join(', ')}${modelsToTry.length > 6 ? ' …' : ''}\n` +
    `에러 그룹:\n${groupedLines.join('\n')}`;
  
  throw new Error(`Gemini API 오류: ${errorMsg}`);
}

/**
 * 마이그레이션 관련 질문에 특화된 프롬프트 생성
 * @param {string} question - 사용자 질문
 * @param {Object} context - 프로젝트 컨텍스트 정보
 * @returns {string} 완성된 프롬프트
 */
function createMigrationPrompt(question, context = {}) {
  const systemPrompt = `You are an expert in React to Next.js migration. 
You help developers migrate their React (Vite) projects to Next.js App Router.

Current project context:
- Build tool: ${context.buildTool || 'Vite'}
- Language: ${context.language || 'TypeScript'}
- Package manager: ${context.packageManager || 'npm'}

Provide clear, actionable advice for React to Next.js migration.

Scope rules:
${getNextifyScopeRules()}`;

  return `${systemPrompt}\n\nUser question: ${question}\n\nAnswer:`;
}

/**
 * 스트리밍 응답 생성 (실시간 출력)
 * @param {string} prompt - 사용자 프롬프트
 * @param {Function} onChunk - 청크 수신 콜백 함수
 * @param {Object} options - 추가 옵션
 */
async function generateTextStream(prompt, onChunk, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 환경 변수를 설정해주세요.');
  }
  
  const client = initGeminiClient(apiKey);
  
  // 먼저 사용 가능한 모델 목록 조회
  let availableModelNames = [];
  try {
    const availableModels = await listAvailableModels(apiKey);
    availableModelNames = availableModels.map(m => m.name?.split('/').pop() || m.name).filter(Boolean);
  } catch (listError) {
    // 모델 목록 조회 실패 시 기본 모델 사용
  }
  
  // generateText() 와 동일 정책: v1beta SDK 가 실제 호출 가능한 모델만 박아둡니다.
  const defaultModels = [
    options.model,
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ].filter(Boolean);
  
  // 사용 가능한 모델 목록과 기본 모델 목록을 합치고 중복 제거
  const modelsToTry = availableModelNames.length > 0 
    ? [...new Set([options.model, ...availableModelNames, ...defaultModels])].filter(Boolean)
    : defaultModels;
  
  const perModelErrors = [];
  
  for (const modelName of modelsToTry) {
    try {
      const model = client.getGenerativeModel({ 
        model: modelName,
        ...options.modelOptions 
      });
      
      const result = options?.signal
        ? await model.generateContentStream(prompt, { signal: options.signal })
        : await model.generateContentStream(prompt);
      
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        if (chunkText && onChunk) {
          onChunk(chunkText);
        }
      }
      return; // 성공 시 종료
    } catch (error) {
      perModelErrors.push({ model: modelName, message: error?.message || String(error) });
      // 다음 모델 시도
      continue;
    }
  }
  
  // 모든 모델 실패 — 에러를 그룹핑해 진짜 원인을 노출 (마지막 모델의 404 같은 노이즈가
  // lastError 자리를 차지하지 않도록 함).
  const grouped = new Map();
  for (const e of perModelErrors) {
    const key = (e.message || '').slice(0, 200);
    const arr = grouped.get(key) || [];
    arr.push(e.model);
    grouped.set(key, arr);
  }
  const groupedLines = [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([msg, models]) => `  - [${models.length}개 모델] ${models.slice(0, 3).join(', ')}${models.length > 3 ? ' …' : ''}\n    → ${msg}`);
  
  const errorMsg =
    `모든 모델 시도 실패 (${modelsToTry.length}개).\n` +
    `시도한 모델: ${modelsToTry.slice(0, 6).join(', ')}${modelsToTry.length > 6 ? ' …' : ''}\n` +
    `에러 그룹:\n${groupedLines.join('\n')}`;
  
  throw new Error(`Gemini API 오류: ${errorMsg}`);
}

/**
 * 사용자 직접처리 도움말을 Gemini에게 요청
 * @param {string} issueDescription - 사용자 직접처리 필요한 문제 설명
 * @param {Object} context - 문제 컨텍스트 (예: { proxyKey, targetUrl, reason, forbiddenOptions })
 * @param {Object} projectContext - 프로젝트 컨텍스트 정보
 * @returns {Promise<string>} Gemini의 도움말 응답
 */
async function getManualProcessingHelp(issueDescription, context = {}, projectContext = {}) {
  const prompt = `You are an expert in React to Next.js migration.

Scope rules:
${getNextifyScopeRules()}

A manual processing issue has been detected during migration:

Issue: ${issueDescription}

Context:
${JSON.stringify(context, null, 2)}

Project Context:
- Build tool: ${projectContext.buildTool || 'Vite'}
- Language: ${projectContext.language || 'TypeScript'}
- Package manager: ${projectContext.packageManager || 'npm'}

Please provide:
1. A clear explanation of why this needs manual processing
2. Step-by-step instructions on how to resolve it
3. Code examples if applicable
4. Best practices for Next.js

Answer in Korean.`;

  return await generateText(prompt);
}

/**
 * 사용자 직접처리 부분에서 Gemini 사용 여부를 사용자에게 물어보는 함수
 * @param {string} issueDescription - 사용자 직접처리 필요한 문제 설명
 * @param {Object} context - 문제 컨텍스트
 * @param {Object} projectContext - 프로젝트 컨텍스트
 * @returns {Promise<boolean>} 사용자가 Gemini 사용을 원하면 true, 아니면 false
 */
async function askForGeminiHelp(issueDescription, context = {}, projectContext = {}) {
  const inquirer = require('inquirer');
  const chalk = require('chalk');

  // API 키 확인
  if (!process.env.GEMINI_API_KEY) {
    return false; // API 키가 없으면 물어보지 않음
  }

  const answer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useGemini',
      message: chalk.yellow('🤖 Gemini AI의 도움을 받으시겠습니까?'),
      default: false,
    },
  ]);

  if (answer.useGemini) {
    try {
      console.log(chalk.blue('\n🤖 Gemini AI가 답변을 생성하고 있습니다...\n'));
      const help = await getManualProcessingHelp(issueDescription, context, projectContext);
      console.log(chalk.green('\n📝 Gemini AI 도움말:\n'));
      console.log(chalk.white(help));
      console.log('\n');
      return true;
    } catch (error) {
      console.error(chalk.red(`\n❌ Gemini API 오류: ${error.message}\n`));
      return false;
    }
  }

  return false;
}

module.exports = {
  initGeminiClient,
  generateText,
  generateTextStream,
  createMigrationPrompt,
  getNextifyScopeRules,
  getManualProcessingHelp,
  askForGeminiHelp,
  listAvailableModels,
};

