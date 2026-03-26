const { GoogleGenerativeAI } = require('@google/generative-ai');

let geminiClient = null;

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
  
  // 사용 가능한 모델이 있으면 그것을 우선 사용, 없으면 기본 모델 목록 사용
  // 2026년 3월 기준 최신 버전부터 우선순위로 나열
  const defaultModels = [
    options.model,
    'gemini-4.0-flash',
    'gemini-4.0-pro',
    'gemini-3.5-flash',
    'gemini-3.5-pro',
    'gemini-3.0-flash',
    'gemini-3.0-pro',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ].filter(Boolean);
  
  // 사용 가능한 모델 목록과 기본 모델 목록을 합치고 중복 제거
  const modelsToTry = availableModelNames.length > 0 
    ? [...new Set([options.model, ...availableModelNames, ...defaultModels])].filter(Boolean)
    : defaultModels;
  
  let lastError = null;
  
  for (const modelName of modelsToTry) {
    try {
      const model = client.getGenerativeModel({ 
        model: modelName,
        ...options.modelOptions 
      });
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      lastError = error;
      // 다음 모델 시도
      continue;
    }
  }
  
  // 모든 모델 실패 시 에러 메시지 개선
  const errorMsg = availableModelNames.length > 0
    ? `모든 모델 시도 실패. 시도한 모델: ${modelsToTry.slice(0, 5).join(', ')}${modelsToTry.length > 5 ? '...' : ''}. 마지막 에러: ${lastError?.message || '알 수 없는 오류'}`
    : `모든 모델 시도 실패. 마지막 에러: ${lastError?.message || '알 수 없는 오류'}`;
  
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

Provide clear, actionable advice for React to Next.js migration.`;

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
  
  // 사용 가능한 모델이 있으면 그것을 우선 사용, 없으면 기본 모델 목록 사용
  // 2026년 3월 기준 최신 버전부터 우선순위로 나열
  const defaultModels = [
    options.model,
    'gemini-4.0-flash',
    'gemini-4.0-pro',
    'gemini-3.5-flash',
    'gemini-3.5-pro',
    'gemini-3.0-flash',
    'gemini-3.0-pro',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ].filter(Boolean);
  
  // 사용 가능한 모델 목록과 기본 모델 목록을 합치고 중복 제거
  const modelsToTry = availableModelNames.length > 0 
    ? [...new Set([options.model, ...availableModelNames, ...defaultModels])].filter(Boolean)
    : defaultModels;
  
  let lastError = null;
  
  for (const modelName of modelsToTry) {
    try {
      const model = client.getGenerativeModel({ 
        model: modelName,
        ...options.modelOptions 
      });
      
      const result = await model.generateContentStream(prompt);
      
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        if (chunkText && onChunk) {
          onChunk(chunkText);
        }
      }
      return; // 성공 시 종료
    } catch (error) {
      lastError = error;
      // 다음 모델 시도
      continue;
    }
  }
  
  // 모든 모델 실패 시 에러 메시지 개선
  const errorMsg = availableModelNames.length > 0
    ? `모든 모델 시도 실패. 시도한 모델: ${modelsToTry.slice(0, 5).join(', ')}${modelsToTry.length > 5 ? '...' : ''}. 마지막 에러: ${lastError?.message || '알 수 없는 오류'}`
    : `모든 모델 시도 실패. 마지막 에러: ${lastError?.message || '알 수 없는 오류'}`;
  
  throw new Error(`Gemini API 오류: ${errorMsg}`);
}

/**
 * 수동 처리 도움말을 Gemini에게 요청
 * @param {string} issueDescription - 수동 처리 필요한 문제 설명
 * @param {Object} context - 문제 컨텍스트 (예: { proxyKey, targetUrl, reason, forbiddenOptions })
 * @param {Object} projectContext - 프로젝트 컨텍스트 정보
 * @returns {Promise<string>} Gemini의 도움말 응답
 */
async function getManualProcessingHelp(issueDescription, context = {}, projectContext = {}) {
  const prompt = `You are an expert in React to Next.js migration.

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
 * 수동 처리 부분에서 Gemini 사용 여부를 사용자에게 물어보는 함수
 * @param {string} issueDescription - 수동 처리 필요한 문제 설명
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
  getManualProcessingHelp,
  askForGeminiHelp,
  listAvailableModels,
};

