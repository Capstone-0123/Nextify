const { Project, SyntaxKind } = require('ts-morph');
const path = require('path');
const fs = require('fs-extra');

/**
 * App.tsx 기준의 import 경로를 page.tsx 기준의 상대 경로로 변환하는 함수
 */
function calculateNewImportPath(originalImportPath, routerFilePath, newPageFilePath) {
  // 1. 라이브러리나 Alias(@)는 그대로 반환
  if (!originalImportPath.startsWith('.')) return originalImportPath;

  // 2. 컴포넌트의 절대 경로 계산
  const appDir = path.dirname(routerFilePath);
  const componentAbsolutePath = path.resolve(appDir, originalImportPath);

  // 3. page.tsx 위치 기준 상대 경로 계산
  const newPageDir = path.dirname(newPageFilePath);
  let newRelativePath = path.relative(newPageDir, componentAbsolutePath);

  // 4. 경로 포맷 정리 (Windows 역슬래시 -> 슬래시)
  newRelativePath = newRelativePath.split(path.sep).join('/');
  if (!newRelativePath.startsWith('.')) newRelativePath = './' + newRelativePath;

  return newRelativePath;
}

async function generateHomePage(projectRoot) {
  console.log('🏠 홈 페이지(src/app/page.tsx) 생성 시작...');

  // 1. App.tsx (라우터 파일) 읽기
  const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: fs.existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
  });

  const routerPath = path.join(projectRoot, 'src/App.tsx');
  if (!fs.existsSync(routerPath)) {
    console.warn('⚠️ src/App.tsx가 없어 홈 페이지 생성을 건너뜁니다.');
    return;
  }

  const routerFile = project.addSourceFileAtPath(routerPath);

  // 2. <Route path="/" ... /> 또는 <Route index ... /> 찾기
  const routeElements = routerFile
    .getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
    .filter((node) => node.getTagNameNode().getText() === 'Route');

  let homeComponentName = null;

  for (const route of routeElements) {
    const pathAttr = route.getAttribute('path');
    const indexAttr = route.getAttribute('index');

    // path="/" 이거나 index 속성이 있는지 확인
    const isRoot = (pathAttr && pathAttr.getInitializer().getText().includes('/')) || indexAttr;

    if (isRoot) {
      const elementAttr = route.getAttribute('element');
      if (elementAttr) {
        // element={<Home />} 에서 'Home' 추출
        const match = elementAttr
          .getInitializer()
          .getText()
          .match(/<(\w+)/);
        if (match) {
          homeComponentName = match[1];
          break;
        }
      }
    }
  }

  if (!homeComponentName) {
    console.warn("⚠️ 루트 경로('/')에 해당하는 컴포넌트를 찾지 못했습니다.");
    return;
  }

  // 3. 해당 컴포넌트의 Import 경로 찾기
  let homeImportPath = '';
  const importDecl = routerFile.getImportDeclaration(
    (decl) =>
      decl.getNamedImports().some((n) => n.getName() === homeComponentName) ||
      decl.getDefaultImport()?.getText() === homeComponentName,
  );

  const targetFile = path.join(projectRoot, 'src', 'app', 'page.tsx');

  if (importDecl) {
    const originalPath = importDecl.getModuleSpecifierValue();
    // 경로 재계산 (App.tsx 기준 -> page.tsx 기준)
    homeImportPath = calculateNewImportPath(originalPath, routerPath, targetFile);
  } else {
    // import가 없으면 같은 파일에 있는 것으로 간주하거나 추측
    homeImportPath = `../../components/${homeComponentName}`;
  }

  // 4. src/app/page.tsx 파일 생성
  const pageContent = `
/**
 * 메인 페이지 (자동 생성됨)
 * 원본 컴포넌트: ${homeComponentName}
 */

import type { ReactNode } from "react";
import ${homeComponentName} from '${homeImportPath}';

export default function HomePage() {
  return <${homeComponentName} />;
}
`;

  await fs.ensureDir(path.dirname(targetFile));
  await fs.writeFile(targetFile, pageContent.trim());
  console.log(`✅ 생성 완료: src/app/page.tsx (컴포넌트: ${homeComponentName})`);
}

module.exports = { generateHomePage };
