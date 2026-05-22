// src/step6/dynamic-import-migrator.cjs
// Dynamic Import 적용

const fs = require('fs-extra');
const path = require('path');
const { sweepAfterAiApply } = require('../utils/post-ai-sweep.cjs');
const { loadNextifyProjectConfig } = require('../utils/nextify-project-config.cjs');

/**
 * `import(".../Hero")` 등에서 모듈 파일 베이스네임 추출 (확장자 제거).
 */
function basenameFromImportSpecifier(spec) {
  const normalized = String(spec).trim().replace(/^["']|["']$/g, '');
  const seg = normalized.split(/[/\\]/).pop() || '';
  return seg.replace(/\.(tsx|jsx|ts|js)$/i, '');
}

/**
 * `.nextify` 의 lcpImageFilenameBaseNames 와 일치하면 LCP 상단 후보 컴포넌트로 보고
 * next/dynamic 분리 대상에서 제외합니다 (조건부 렌더링 Case a 등).
 */
function importSpecTargetsLcpCritical(importPath, lcpBaseNames) {
  const base = basenameFromImportSpecifier(importPath);
  return lcpBaseNames.some((b) => b.toLowerCase() === base.toLowerCase());
}

/**
 * 이전 실행 등으로 남은 `const Hero = dynamic(() => import("...Hero"))` 를
 * `import Hero from "..."` 로 되돌립니다 (LCP 지연 방지).
 */
async function revertDynamicImportsForLcpComponents(projectRoot) {
  const cfg = loadNextifyProjectConfig(projectRoot);
  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) return;

  async function walk(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          files.push(...(await walk(full)));
        }
      } else if (/\.(tsx|jsx)$/.test(item.name)) {
        files.push(full);
      }
    }
    return files;
  }

  const re =
    /\bconst\s+(\w+)\s*=\s*dynamic\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*(["'])([^"']+)\2\s*\)\s*(?:,\s*\{[^}]*\})?\s*\)\s*;?\s*\r?\n?/g;

  const files = await walk(srcDir);
  for (const filePath of files) {
    let content = await fs.readFile(filePath, 'utf-8');
    const original = content;
    let changed = false;

    content = content.replace(re, (full, id, q, spec) => {
      if (!importSpecTargetsLcpCritical(spec, cfg.lcpImageFilenameBaseNames)) {
        return full;
      }
      if (new RegExp(`(^|\\n)\\s*import\\s+${id}\\s+from\\s+["']`, 'm').test(content)) {
        return full;
      }
      changed = true;
      return `import ${id} from ${q}${spec}${q};\n`;
    });

    if (changed && content !== original) {
      if (!/\bdynamic\s*\(/.test(content)) {
        content = content.replace(/^import\s+dynamic\s+from\s+["']next\/dynamic["'];?\s*\r?\n?/m, '');
        content = content.replace(/\nimport\s+dynamic\s+from\s+["']next\/dynamic["'];?\s*\r?\n?/gi, '\n');
      }
      content = content.replace(/^\s*;\s*\n/m, '').replace(/\n{3,}/g, '\n\n');
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }
}

//=========================================================
// 공용 유틸
//=========================================================

/**
 * 파일 본문 첫 비주석 statement가 'use client' 인지 확인.
 * - 단순 패턴이지만 99% 케이스는 정확히 잡힘.
 */
function hasUseClientDirective(content) {
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use client['"]\s*;?/.test(content);
}

/**
 * App Router 특수 파일(page/layout/template/loading/not-found/default)인지 확인.
 * error.tsx는 의무적으로 Client Component이므로 제외.
 */
function isAppRouterServerSpecialFile(filePath) {
  const norm = String(filePath).split(path.sep).join('/');
  return /(?:^|\/)(?:src\/)?app\/(?:.+\/)?(?:page|layout|template|loading|not-found|default)\.tsx?$/.test(norm);
}

/**
 * 파일이 metadata / generateMetadata 를 export 하는지 검사.
 * - export const metadata, export async function generateMetadata, export { metadata } 등
 */
function hasMetadataExport(content) {
  if (/\bexport\s+(?:const|let|var|function|async\s+function)\s+(?:metadata|generateMetadata)\b/.test(content)) {
    return true;
  }
  // export { metadata } 또는 export { generateMetadata as ... }
  return /\bexport\s*\{[^}]*\b(?:metadata|generateMetadata)\b[^}]*\}/.test(content);
}

/**
 * 해당 파일에 dynamic(..., { ssr: false }) 패턴을 안전하게 삽입할 수 있는지 판정.
 * - 'use client' 가 이미 있으면 OK (Client Component)
 * - metadata export 가 있거나 App Router 서버 파일이면 NG (Server Component)
 * - 그 외에는 (애매하면) NG로 보수적 판정
 *
 * NG일 때는 import를 dynamic으로 변환하지 않고 정적 import를 그대로 둡니다.
 * (정적 import는 Next.js App Router에서 자체 코드 스플리팅을 받으므로 빌드는 깨지지 않습니다.)
 */
function canInjectDynamicWithSsrFalse(targetFilePath, targetContent) {
  if (hasUseClientDirective(targetContent)) return true;
  if (hasMetadataExport(targetContent)) return false;
  if (isAppRouterServerSpecialFile(targetFilePath)) return false;
  return false;
}

function insertDynamicDeclAfterImports(content, declBlock) {
  const importLineRe = /^import[^\n]*?from\s+["'][^"']+["']\s*;?\s*\n/gm;
  let lastEnd = 0;
  let m;
  while ((m = importLineRe.exec(content)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd > 0) {
    return content.slice(0, lastEnd) + declBlock + content.slice(lastEnd);
  }
  return declBlock + content;
}

/**
 * package.json 에 설치된 무거운 패키지의 default import 를 dynamic(..., { ssr: false }) 로 분리합니다.
 */
async function migrateHeavyDefaultPackageImports(projectRoot) {
  const cfg = loadNextifyProjectConfig(projectRoot);
  const pkgJsonPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;

  let deps = {};
  try {
    const j = await fs.readJson(pkgJsonPath);
    deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
  } catch {
    return;
  }

  const active = cfg.heavyDefaultImportPackages.filter((p) =>
    Object.prototype.hasOwnProperty.call(deps, p),
  );
  if (active.length === 0) return;

  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) return;

  async function findTsxJsx(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          files.push(...(await findTsxJsx(fullPath)));
        }
      } else if (/\.(tsx|jsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const allFiles = await findTsxJsx(srcDir);
  for (const filePath of allFiles) {
    let content = await fs.readFile(filePath, 'utf-8');
    const original = content;
    let changed = false;

    for (const pkg of active) {
      const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const importRe = new RegExp(
        `(^|\\n)(import\\s+(\\w+)\\s+from\\s+["']${escaped}["']\\s*;?\\s*\\r?\\n?)`,
        'm',
      );
      const mm = content.match(importRe);
      if (!mm) continue;
      const ident = mm[3];
      if (new RegExp(`\\bconst\\s+${ident}\\s*=\\s*dynamic\\s*\\(`).test(content)) {
        continue;
      }

      const withoutImport = content.replace(importRe, mm[1] || '\n');
      if (!canInjectDynamicWithSsrFalse(filePath, withoutImport)) {
        continue;
      }

      const hasDynImp = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(withoutImport);
      const importDyn = hasDynImp ? '' : `import dynamic from "next/dynamic";\n`;
      const decl = `${importDyn}const ${ident} = dynamic(() => import("${pkg}"), { ssr: false });\n`;
      content = insertDynamicDeclAfterImports(withoutImport, decl);
      changed = true;
    }

    if (changed && content !== original) {
      content = content
        .replace(/^\s*;\s*\n/m, '')
        .replace(/\n{3,}/g, '\n\n');
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }
}

//=========================================================
// Dynamic Import 적용 메인 함수
//=========================================================
async function optimizeDynamicImport(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  
  // src/ 디렉터리가 존재하지 않으면 종료
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // LCP 상단 후보(Hero 등)는 dynamic 청크 분리 시 지연이 커질 수 있어 먼저 정적 import 로 되돌림
  await revertDynamicImportsForLcpComponents(projectRoot);

  await migrateHeavyDefaultPackageImports(projectRoot);

  // Case a: 조건부 렌더링 컴포넌트
  await migrateConditionalRenderingComponents(projectRoot);

  // Case b: 브라우저 전용 API 사용하는 컴포넌트
  await migrateBrowserAPIComponents(projectRoot);

  // Case c: 이벤트 핸들러 내부에서만 사용하는 외부 라이브러리
  await migrateEventHandlerLibraries(projectRoot);

  // Case d: React.lazy 사용 코드
  await migrateReactLazy(projectRoot);

  // Case e: 대형 UI 라이브러리 컴포넌트
  await migrateLargeUIComponents(projectRoot);

  // [최종 안전망] src 전체에서 Server Component 에 박힌 dynamic(..., { ssr: false }) 의
  //   ssr: false 만 결정론적으로 제거 (post-ai-sweep 재사용).
  // - 위 5개 case 의 결정론 변환에서 이미 차단했지만, 사용자 수동 편집/이전 실행 잔재 등
  //   다른 경로로 들어온 패턴도 빌드를 깨지 않도록 무력화.
  // - LLM 호출 0, 파일당 수십 ms.
  try {
    const srcDir = path.join(projectRoot, 'src');
    if (fs.existsSync(srcDir)) {
      const tsxFiles = await collectTsxRelPaths(projectRoot, srcDir);
      if (tsxFiles.length > 0) {
        await sweepAfterAiApply(projectRoot, tsxFiles);
      }
    }
  } catch (err) {
    // 안전망 자체 실패는 마이그레이션을 막지 않음
    console.log(`   ⚠️  ssr:false 안전망 sweep 스킵: ${err && err.message ? err.message : err}`);
  }
}

/**
 * src/ 하위 .tsx 파일을 projectRoot 기준 상대경로(POSIX)로 모음.
 */
async function collectTsxRelPaths(projectRoot, srcDir) {
  const out = [];
  async function walk(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (['node_modules', '.next', '.git', 'dist', 'build'].includes(item.name)) continue;
        await walk(full);
      } else if (item.isFile() && /\.tsx$/.test(item.name)) {
        out.push(path.relative(projectRoot, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(srcDir);
  return out;
}

//=========================================================
// Case a: 조건부 렌더링 컴포넌트
//=========================================================
async function migrateConditionalRenderingComponents(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const cfg = loadNextifyProjectConfig(projectRoot);

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 2. JSX 내부에서 조건부 렌더링 패턴 찾기
    // 조건 && <ComponentIdentifier /> 또는 조건 ? <ComponentIdentifier /> : null
    const conditionalPatterns = [
      // 조건 && <ComponentIdentifier />
      /(\w+)\s*&&\s*<(\w+)\s*[^>]*\/>/g,
      // 조건 ? <ComponentIdentifier /> : null
      /(\w+)\s*\?\s*<(\w+)\s*[^>]*\/>\s*:\s*null/g,
    ];

    const componentIdentifiers = new Set();

    for (const pattern of conditionalPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const componentIdentifier = match[2];
        componentIdentifiers.add(componentIdentifier);
      }
    }

    if (componentIdentifiers.size === 0) {
      return; // 조건부 렌더링 패턴이 없으면 종료
    }

    // 3. 파일 최상단에서 정적 import 확인
    let importsToConvert = [];
    for (const componentIdentifier of componentIdentifiers) {
      // import ComponentIdentifier from "ComponentImportPath" 패턴 찾기
      const importPattern = new RegExp(`import\\s+${componentIdentifier}\\s+from\\s+["']([^"']+)["']`, 'g');
      let importMatch;
      while ((importMatch = importPattern.exec(content)) !== null) {
        importsToConvert.push({
          componentIdentifier,
          importPath: importMatch[1],
          fullMatch: importMatch[0],
        });
      }
    }

    importsToConvert = importsToConvert.filter(
      (imp) => !importSpecTargetsLcpCritical(imp.importPath, cfg.lcpImageFilenameBaseNames),
    );

    if (importsToConvert.length === 0) {
      return; // 변환할 import가 없으면 종료
    }

    // 4. 해당 import 문 제거
    // 5. 제거한 자리에 import dynamic from "next/dynamic" 추가
    const hasDynamicImport = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(content);
    
    for (const imp of importsToConvert) {
      // import 문 제거
      content = content.replace(imp.fullMatch, '');
    }

    // dynamic import 추가 (없는 경우)
    if (!hasDynamicImport) {
      const firstImportMatch = content.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        content = content.slice(0, insertIndex) +
          'import dynamic from "next/dynamic";\n' +
          content.slice(insertIndex);
      } else {
        content = 'import dynamic from "next/dynamic";\n' + content;
      }
    }

    // 6. 기존 import를 dynamic import로 변경
    for (const imp of importsToConvert) {
      // const ComponentIdentifier = dynamic(() => import("ComponentImportPath")) 형태로 추가
      const dynamicImportLine = `const ${imp.componentIdentifier} = dynamic(() => import("${imp.importPath}"));\n`;
      
      // 첫 번째 import 문 다음에 추가
      const firstImportMatch = content.match(/^import\s+[^;]+;?\s*\n/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index + firstImportMatch[0].length;
        content = content.slice(0, insertIndex) +
          dynamicImportLine +
          content.slice(insertIndex);
      } else {
        content = dynamicImportLine + content;
      }
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case b: 브라우저 전용 API 사용하는 컴포넌트
//=========================================================
async function migrateBrowserAPIComponents(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 2. 컴포넌트 내부 코드에서 브라우저 API 사용 여부 확인
    const browserAPIs = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage'];
    const browserAPIPattern = new RegExp(`\\b(${browserAPIs.join('|')})\\.`, 'g');
    
    if (!browserAPIPattern.test(content)) {
      return; // 브라우저 API 사용이 없으면 종료
    }

    // 3. 해당 API가 컴포넌트 렌더링 단계(함수 본문)에서 사용되는지 확인
    // 함수 컴포넌트 내부에서 사용되는지 확인
    const functionComponentPattern = /(?:export\s+)?(?:default\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{([^}]+)\}/g;
    const componentsWithBrowserAPI = [];

    let match;
    while ((match = functionComponentPattern.exec(content)) !== null) {
      const componentBody = match[2];
      if (browserAPIPattern.test(componentBody)) {
        componentsWithBrowserAPI.push(match[1]);
      }
    }

    if (componentsWithBrowserAPI.length === 0) {
      return; // 컴포넌트 렌더링 단계에서 사용되지 않으면 종료
    }

    // 4. 위 API를 사용하는 컴포넌트가 다른 파일에서 정적 import 되어 있는지 검사
    //    - regex가 trailing `;` 와 newline 까지 함께 잡도록 강화 (이전엔 `;` 잔재가 남아 leading `;` 아티팩트 발생).
    const buildImportPattern = (componentName) =>
      new RegExp(`(^|\\n)\\s*import\\s+${componentName}\\s+from\\s+["']([^"']+)["']\\s*;?\\s*\\n?`, 'g');

    const importsToConvert = [];
    for (const componentName of componentsWithBrowserAPI) {
      const importPattern = buildImportPattern(componentName);
      let importMatch;
      while ((importMatch = importPattern.exec(content)) !== null) {
        importsToConvert.push({
          componentIdentifier: componentName,
          importPath: importMatch[2],
          fullMatch: importMatch[0],
          leading: importMatch[1] || '',
        });
      }
    }

    // 다른 파일에서 import하는 경우를 찾기 위해 모든 파일 검사
    const allFiles = await findTsFiles(srcDir);
    for (const otherFilePath of allFiles) {
      if (otherFilePath === filePath) continue;
      
      const otherContent = await fs.readFile(otherFilePath, 'utf-8');
      for (const componentName of componentsWithBrowserAPI) {
        const importPattern = buildImportPattern(componentName);
        let importMatch;
        while ((importMatch = importPattern.exec(otherContent)) !== null) {
          importsToConvert.push({
            componentIdentifier: componentName,
            importPath: importMatch[2],
            fullMatch: importMatch[0],
            leading: importMatch[1] || '',
            filePath: otherFilePath,
          });
        }
      }
    }

    if (importsToConvert.length === 0) {
      return; // 변환할 import가 없으면 종료
    }

    // 5-7. import 문 제거, dynamic import 추가, ssr: false 옵션 추가
    //    - Server Component 타겟(metadata export, App Router page/layout 등)은 스킵.
    //      ssr: false 는 Client Component 에서만 허용되므로, 그대로 박으면 빌드가 깨짐.
    //    - 이미 같은 컴포넌트의 dynamic 선언이 있으면 멱등성을 위해 스킵.
    //    - import dynamic 과 const X = dynamic(...) 를 인접하게 삽입(이전엔 떨어져서 가독성/ordering 망가짐).
    for (const imp of importsToConvert) {
      const targetFilePath = imp.filePath || filePath;
      let targetContent = await fs.readFile(targetFilePath, 'utf-8');
      const originalTargetContent = targetContent;

      // [멱등성] 이미 const Foo = dynamic(...) 선언이 있으면 건드리지 않음.
      const alreadyHasDynamicDecl = new RegExp(
        `\\bconst\\s+${imp.componentIdentifier}\\s*=\\s*dynamic\\s*\\(`
      ).test(targetContent);
      if (alreadyHasDynamicDecl) {
        continue;
      }

      // [안전망] Server Component 에는 ssr: false 를 절대 박지 않음.
      //   - 정적 import 를 그대로 두는 편이 빌드 안전.
      //   - Next.js 가 page-level chunking 을 자동 수행하므로 코드 스플리팅 손실 미미.
      if (!canInjectDynamicWithSsrFalse(targetFilePath, targetContent)) {
        // 정보 메시지(혼동 방지를 위해 건너뛴 사유 표기)
        const reason = hasMetadataExport(targetContent)
          ? 'metadata export 보유'
          : isAppRouterServerSpecialFile(targetFilePath)
            ? 'App Router Server Component'
            : "'use client' 미보유";
        const rel = path.relative(projectRoot, targetFilePath).split(path.sep).join('/');
        console.log(`    ⏭️  ${rel} — ${reason}, Server Component이라 Dynamic Import 미적용`);
        continue;
      }

      // import 문 제거 (선행 \n 보존을 위해 매칭 시 잡았던 leading 을 유지)
      targetContent = targetContent.replace(imp.fullMatch, imp.leading || '\n');

      // 마지막 import 위치 탐지
      const importLineRe = /^import[^\n]*?from\s+["'][^"']+["']\s*;?\s*\n/gm;
      let lastImportEnd = 0;
      let m;
      while ((m = importLineRe.exec(targetContent)) !== null) {
        lastImportEnd = m.index + m[0].length;
      }

      const hasDynamicImport = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(targetContent);
      const dynamicDecl = `const ${imp.componentIdentifier} = dynamic(() => import("${imp.importPath}"), { ssr: false });\n`;
      const importLine = hasDynamicImport ? '' : 'import dynamic from "next/dynamic";\n';
      const inject = importLine + dynamicDecl;

      if (lastImportEnd > 0) {
        targetContent = targetContent.slice(0, lastImportEnd) + inject + targetContent.slice(lastImportEnd);
      } else {
        // import가 하나도 없는 파일이면 최상단에 삽입 (use client 다음 줄 정도가 최선)
        targetContent = inject + targetContent;
      }

      // 깨진 빈 줄/leading `;` 정리 (regex 변환 후 흔히 남는 자투리)
      targetContent = targetContent
        .replace(/^\s*;\s*\n/, '')          // 파일 최상단 leading `;` 제거
        .replace(/\n{3,}/g, '\n\n');        // 과도한 빈 줄 압축

      // 변경사항이 있으면 파일 저장
      if (targetContent !== originalTargetContent) {
        await fs.writeFile(targetFilePath, targetContent, 'utf-8');
      }
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case c: 이벤트 핸들러 내부에서만 사용하는 외부 라이브러리
//=========================================================
async function migrateEventHandlerLibraries(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 2. 파일 최상단 import에서 외부 라이브러리 import 찾기
    const importPattern = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;
    const imports = [];
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      const libraryIdentifier = match[1];
      const libraryImportPath = match[2];
      
      // node_modules에서 가져오는 외부 라이브러리인지 확인
      if (libraryImportPath.startsWith('.') || libraryImportPath.startsWith('@/')) {
        continue; // 로컬 파일이면 건너뛰기
      }

      imports.push({
        libraryIdentifier,
        libraryImportPath,
        fullMatch: match[0],
      });
    }

    if (imports.length === 0) {
      return; // 외부 라이브러리 import가 없으면 종료
    }

    // 3. LibraryIdentifier가 이벤트 핸들러 내부에서만 사용되는지 확인
    const eventHandlerPatterns = [
      /(?:onClick|onChange|onSubmit|onInput|onFocus|onBlur)\s*=\s*\{[^}]*\}/g,
      /(?:handle\w+|on\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{[^}]*\}/g,
      /(?:async\s+)?function\s+(?:handle\w+|on\w+)\s*\([^)]*\)\s*\{[^}]*\}/g,
    ];

    const importsToConvert = [];

    for (const imp of imports) {
      // 이벤트 핸들러 내부에서 사용되는지 확인
      let usedInEventHandler = false;
      let usedOutsideEventHandler = false;

      for (const pattern of eventHandlerPatterns) {
        const handlerMatches = content.matchAll(pattern);
        for (const handlerMatch of handlerMatches) {
          const handlerContent = handlerMatch[0];
          // 이벤트 핸들러 내부에서 사용되는지 확인
          if (new RegExp(`\\b${imp.libraryIdentifier}\\b`).test(handlerContent)) {
            usedInEventHandler = true;
          }
        }
      }

      // 이벤트 핸들러 외부에서 사용되는지 확인
      // 전체 파일에서 이벤트 핸들러를 제외한 부분 확인
      let remainingContent = content;
      for (const pattern of eventHandlerPatterns) {
        remainingContent = remainingContent.replace(pattern, '');
      }
      if (new RegExp(`\\b${imp.libraryIdentifier}\\b`).test(remainingContent)) {
        usedOutsideEventHandler = true;
      }

      // 이벤트 핸들러 내부에서만 사용되고 외부에서는 사용되지 않는 경우
      if (usedInEventHandler && !usedOutsideEventHandler) {
        importsToConvert.push(imp);
      }
    }

    if (importsToConvert.length === 0) {
      return; // 변환할 import가 없으면 종료
    }

    // 4. 해당 import 문 제거
    for (const imp of importsToConvert) {
      content = content.replace(imp.fullMatch, '');
    }

    // 5. 이벤트 핸들러 내부에서 dynamic import 사용하도록 변경
    for (const imp of importsToConvert) {
      // 이벤트 핸들러 패턴 찾기
      for (const pattern of eventHandlerPatterns) {
        content = content.replace(pattern, (handlerMatch) => {
          // 이벤트 핸들러 내부에서 LibraryIdentifier 사용하는지 확인
          if (new RegExp(`\\b${imp.libraryIdentifier}\\b`).test(handlerMatch)) {
            // async 함수로 변경 (아직 async가 아닌 경우)
            let newHandler = handlerMatch;
            if (!newHandler.includes('async')) {
              newHandler = newHandler.replace(/(?:const\s+)?(\w+)\s*=\s*(?:async\s*)?\(/, 'const $1 = async (');
              newHandler = newHandler.replace(/(?:async\s+)?function\s+(\w+)\s*\(/, 'async function $1 (');
            }
            
            // 이벤트 핸들러 시작 부분에 dynamic import 추가
            const dynamicImportLine = `const ${imp.libraryIdentifier} = (await import("${imp.libraryImportPath}")).default;\n`;
            
            // 함수 본문 시작 부분 찾기
            const bodyStartIndex = newHandler.indexOf('{');
            if (bodyStartIndex !== -1) {
              newHandler = newHandler.slice(0, bodyStartIndex + 1) +
                '\n' + dynamicImportLine +
                newHandler.slice(bodyStartIndex + 1);
            }
            
            return newHandler;
          }
          return handlerMatch;
        });
      }
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case d: React.lazy 사용 코드
//=========================================================
async function migrateReactLazy(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 1. React.lazy 패턴 찾기
    // const ComponentIdentifier = React.lazy(() => import("ComponentImportPath"))
    const reactLazyPattern = /const\s+(\w+)\s*=\s*React\.lazy\s*\(\s*\(\)\s*=>\s*import\s*\(["']([^"']+)["']\)\s*\)/g;
    const lazyComponents = [];
    let match;

    while ((match = reactLazyPattern.exec(content)) !== null) {
      lazyComponents.push({
        componentIdentifier: match[1],
        importPath: match[2],
        fullMatch: match[0],
      });
    }

    if (lazyComponents.length === 0) {
      return; // React.lazy 패턴이 없으면 종료
    }

    // 3. 해당 코드 제거
    for (const lazy of lazyComponents) {
      content = content.replace(lazy.fullMatch, '');
    }

    // 4. 파일 상단에 import dynamic from "next/dynamic" 추가
    const hasDynamicImport = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(content);
    if (!hasDynamicImport) {
      const firstImportMatch = content.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        content = content.slice(0, insertIndex) +
          'import dynamic from "next/dynamic";\n' +
          content.slice(insertIndex);
      } else {
        content = 'import dynamic from "next/dynamic";\n' + content;
      }
    }

    // 5. dynamic import 형태로 변경
    for (const lazy of lazyComponents) {
      const dynamicImportLine = `const ${lazy.componentIdentifier} = dynamic(() => import("${lazy.importPath}"));\n`;
      
      const firstImportMatch = content.match(/^import\s+[^;]+;?\s*\n/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index + firstImportMatch[0].length;
        content = content.slice(0, insertIndex) +
          dynamicImportLine +
          content.slice(insertIndex);
      } else {
        content = dynamicImportLine + content;
      }
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

//=========================================================
// Case e: 대형 UI 라이브러리 컴포넌트
//=========================================================
async function migrateLargeUIComponents(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');

  // 대형 UI 컴포넌트 목록
  const largeUIComponents = ['Chart', 'Editor', 'Map', 'Viewer', 'Player'];

  // 1. src/ 하위 .ts, .tsx 파일 찾기
  async function findTsFiles(dir) {
    const files = [];
    const items = await fs.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!['node_modules', '.next', '.git'].includes(item.name)) {
          const subFiles = await findTsFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (/\.(ts|tsx)$/.test(item.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  // 파일 처리
  async function processFile(filePath) {
    let content = await fs.readFile(filePath, 'utf-8');
    const originalContent = content;

    // 2. 대형 UI 컴포넌트 import 여부 확인
    const importsToConvert = [];
    for (const componentName of largeUIComponents) {
      // import ComponentIdentifier from "ComponentImportPath" 패턴 찾기
      const importPattern = new RegExp(`import\\s+${componentName}\\s+from\\s+["']([^"']+)["']`, 'g');
      let importMatch;
      while ((importMatch = importPattern.exec(content)) !== null) {
        importsToConvert.push({
          componentIdentifier: componentName,
          importPath: importMatch[1],
          fullMatch: importMatch[0],
        });
      }
    }

    if (importsToConvert.length === 0) {
      return; // 대형 UI 컴포넌트 import가 없으면 종료
    }

    // 3. 해당 컴포넌트가 항상 초기 렌더에 필요하지 않은지 확인
    // (조건부 렌더링이거나 지연 로딩 가능한 경우)
    // 이 부분은 사용자가 수동으로 확인해야 하므로, 일단 모든 경우에 적용

    // 4. 대형 UI 컴포넌트 정적 import 제거
    for (const imp of importsToConvert) {
      content = content.replace(imp.fullMatch, '');
    }

    // 5. 제거한 자리에 import dynamic from "next/dynamic" 추가
    const hasDynamicImport = /import\s+dynamic\s+from\s+["']next\/dynamic["']/.test(content);
    if (!hasDynamicImport) {
      const firstImportMatch = content.match(/^import\s+/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index;
        content = content.slice(0, insertIndex) +
          'import dynamic from "next/dynamic";\n' +
          content.slice(insertIndex);
      } else {
        content = 'import dynamic from "next/dynamic";\n' + content;
      }
    }

    // 6. dynamic import 형태로 변경
    for (const imp of importsToConvert) {
      const dynamicImportLine = `const ${imp.componentIdentifier} = dynamic(() => import("${imp.importPath}"));\n`;
      
      const firstImportMatch = content.match(/^import\s+[^;]+;?\s*\n/m);
      if (firstImportMatch) {
        const insertIndex = firstImportMatch.index + firstImportMatch[0].length;
        content = content.slice(0, insertIndex) +
          dynamicImportLine +
          content.slice(insertIndex);
      } else {
        content = dynamicImportLine + content;
      }
    }

    // 변경사항이 있으면 파일 저장
    if (content !== originalContent) {
      await fs.writeFile(filePath, content, 'utf-8');
    }
  }

  const files = await findTsFiles(srcDir);
  for (const filePath of files) {
    await processFile(filePath);
  }
}

module.exports = {
  optimizeDynamicImport,
};

