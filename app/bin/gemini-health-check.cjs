#!/usr/bin/env node
'use strict';

// Gemini API 헬스체크. 마이그레이션 중 "모든 모델 시도 실패" 가 발생했을 때
// 진짜 원인(quota / auth / 네트워크 / 모델 부재)을 빠르게 진단하기 위한 1회용 도구.
//
// 사용법: node bin/gemini-health-check.cjs
// 또는:   GEMINI_API_KEY=... node bin/gemini-health-check.cjs

const path = require('path');

// .env 가 있다면 로드 (CLI 와 동일 정책)
try { require('dotenv').config({ path: path.join(process.cwd(), '.env') }); } catch (_) { /* dotenv 없을 수 있음 */ }

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('❌ GEMINI_API_KEY 가 설정되지 않았습니다. .env 또는 환경변수에 키를 넣고 다시 실행하세요.');
  process.exit(1);
}

const https = require('https');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, json: null, raw: data.slice(0, 500) }); }
        });
      })
      .on('error', reject);
  });
}

(async () => {
  console.log('🩺 Gemini 헬스체크 시작\n');

  // 1) v1beta 모델 목록 (SDK 가 실제 호출하는 endpoint)
  console.log('① v1beta/models 목록 조회');
  const v1beta = await httpGetJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (v1beta.status !== 200) {
    console.error(`   ❌ HTTP ${v1beta.status}`);
    console.error(`   raw: ${v1beta.raw || JSON.stringify(v1beta.json).slice(0, 400)}`);
    console.error('\n💡 진단: API key 권한/유효성 문제일 가능성이 높습니다. Google AI Studio 에서 새 키 발급해보세요.');
    process.exit(2);
  }
  const v1betaModels = (v1beta.json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name?.split('/').pop())
    .filter(Boolean);
  console.log(`   ✅ generateContent 지원 모델 ${v1betaModels.length}개`);
  console.log(`      예: ${v1betaModels.slice(0, 6).join(', ')}${v1betaModels.length > 6 ? ' …' : ''}\n`);

  // 2) 가장 가벼운 모델로 실제 호출 (1토큰만 — quota 확인용)
  console.log('② 실제 generateContent 호출 (gemini-2.5-flash, 짧은 prompt)');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const client = new GoogleGenerativeAI(apiKey);

  const candidates = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let success = false;
  const errors = [];
  for (const modelName of candidates) {
    if (!v1betaModels.includes(modelName)) {
      errors.push({ model: modelName, message: 'v1beta/models 에 없음 (skip)' });
      continue;
    }
    try {
      const model = client.getGenerativeModel({ model: modelName });
      const result = await model.generateContent('say "ok"');
      const text = (await result.response).text();
      console.log(`   ✅ ${modelName}: "${text.trim().slice(0, 40)}"`);
      success = true;
      break;
    } catch (e) {
      errors.push({ model: modelName, message: e?.message || String(e) });
    }
  }

  if (!success) {
    console.error('   ❌ 실호출 모두 실패:');
    for (const e of errors) {
      console.error(`      - ${e.model}: ${e.message.slice(0, 200)}`);
    }
    console.error('\n💡 진단:');
    if (errors.some((e) => /quota|rate|429|exceed/i.test(e.message))) {
      console.error('   → quota/rate-limit. AI Studio 콘솔에서 사용량/한도 확인. 잠시 대기 후 재시도.');
    } else if (errors.some((e) => /401|403|API key|permission/i.test(e.message))) {
      console.error('   → 인증/권한 문제. API key 가 v1beta 권한을 가졌는지 AI Studio 에서 확인.');
    } else if (errors.some((e) => /ENOTFOUND|ETIMEDOUT|network/i.test(e.message))) {
      console.error('   → 네트워크 문제. 방화벽/프록시 확인.');
    } else {
      console.error('   → 위 에러 메시지가 진짜 원인입니다. Google 측 일시적 outage 가능성.');
    }
    process.exit(3);
  }

  console.log('\n🎉 Gemini API 정상 작동. migrate-next 를 다시 실행해 보세요.');
})().catch((e) => {
  console.error('\n💥 헬스체크 자체가 실패:', e?.message || e);
  process.exit(99);
});
