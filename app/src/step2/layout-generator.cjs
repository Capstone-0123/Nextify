// src/step2/layout-generator.cjs
// 여기서는 index 파일 읽고 src/layout.tsx 생성 후 매핑까지만 합니다

const fs = require('fs-extra');
const path = require('path');

/**
 * HTML 속성을 JSX 속성으로 변환하는 매핑 테이블
 */
const HTML_TO_JSX_MAP = {
  class: 'className',
  charset: 'charSet',
  crossorigin: 'crossOrigin',
  checked: 'defaultChecked',
  selected: 'defaultValue',
  for: 'htmlFor',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  readonly: 'readOnly',
  tabindex: 'tabIndex',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  datetime: 'dateTime',
  enctype: 'encType',
  maxlength: 'maxLength',
  minlength: 'minLength',
  // 필요한 경우 추가
};

/**
 * HTML 문자열을 JSX 호환 문자열로 변환합니다.
 * 1. 속성 이름 변경 (class -> className)
 * 2. 빈 속성 처리 (crossorigin -> crossOrigin="anonymous")
 * 3. Self-closing 태그 처리 (<link ...> -> <link ... />)
 */
function convertHtmlToJsx(htmlString) {
  if (!htmlString) return '';

  let jsx = htmlString;

  // 1. 주석 제거 (JSX 안에서 는 에러 발생)
  jsx = jsx.replace(/<!--[\s\S]*?-->/g, '');

  // 2. 속성 변환 (Regex 활용)
  // 예: class="box" -> className="box"
  Object.keys(HTML_TO_JSX_MAP).forEach((htmlAttr) => {
    const jsxAttr = HTML_TO_JSX_MAP[htmlAttr];
    // 정확히 속성 위치에 있는 것만 치환하기 위한 정규식
    // (공백 뒤에 오고, = 또는 공백/끝이 오는 경우)
    const regex = new RegExp(`(\\s)${htmlAttr}(?=[\\s=>])`, 'g');
    jsx = jsx.replace(regex, `$1${jsxAttr}`);
  });

  // 3. Boolean 속성 및 특수 케이스 처리
  // crossorigin (값 없이 쓰이면 anonymous로 간주) -> crossOrigin="anonymous"
  jsx = jsx.replace(/\scrossOrigin(?!\=)/g, ' crossOrigin="anonymous"');
  jsx = jsx.replace(/\smuted(?!\=)/g, ' muted={true}');
  jsx = jsx.replace(/\sautoPlay(?!\=)/g, ' autoPlay={true}');

  // 4. Self-closing 태그 강제 적용
  // HTML에서는 <meta>, <link>, <br>, <img> 등을 닫지 않아도 되지만 JSX는 필수
  const voidTags = [
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ];

  voidTags.forEach((tag) => {
    // <tag ... > (슬래시 없이 끝나는 경우) -> <tag ... />
    // 주의: 이미 닫혀있는지(/>) 확인
    const tagRegex = new RegExp(`<${tag}([^>]*?)(?<!/)>`, 'gi');
    jsx = jsx.replace(tagRegex, `<${tag}$1 />`);
  });

  // 5. style 문자열 처리 (단순 문자열은 에러남, 일단 주석 처리하거나 조심해야 함)
  // 복잡성을 피하기 위해 style="..." 속성이 있으면 경고 주석 추가
  if (jsx.includes('style=')) {
    jsx = jsx.replace(/style="([^"]*)"/g, (match, styleContent) => {
      return `style={{ /* TODO: Convert CSS string to Object: ${styleContent} */ }}`;
    });
  }

  return jsx;
}

/**
 * layout.tsx 생성 메인 함수
 */
async function generateLayout(projectRoot) {
  const indexHtmlPath = path.join(projectRoot, 'index.html');
  const targetLayoutPath = path.join(projectRoot, 'src/app/layout.tsx');

  if (!fs.existsSync(indexHtmlPath)) {
    return;
  }

  const htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');

  // 1. HTML 태그 속성 추출 (<html lang="en"> 등)
  const htmlTagMatch = htmlContent.match(/<html([^>]*)>/i);
  const htmlAttributes = htmlTagMatch ? convertHtmlToJsx(htmlTagMatch[1]) : ' lang="en"';

  // 2. Body 태그 속성 추출 (<body class="..."> 등) - 내용은 무시
  const bodyTagMatch = htmlContent.match(/<body([^>]*)>/i);
  const bodyAttributes = bodyTagMatch ? convertHtmlToJsx(bodyTagMatch[1]) : '';

  // 3. Head 내부 콘텐츠 추출
  const headContentMatch = htmlContent.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  let headContent = headContentMatch ? headContentMatch[1] : '';

  // 4. Head 내용 변환 (JSX 문법 적용)
  const convertedHead = convertHtmlToJsx(headContent);

  // 5. 최종 layout.tsx 템플릿 조립
  const layoutContent = `


export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html${htmlAttributes}>
      <head>
        {/* index.html에서 가져온 헤더 내용 */}
        ${convertedHead.trim().split('\n').join('\n        ')}
      </head>
      <body${bodyAttributes}>
        {children}
      </body>
    </html>
  );
}
`;

  // 디렉토리 확인 및 파일 쓰기
  const appDir = path.dirname(targetLayoutPath);
  await fs.ensureDir(appDir);
  await fs.writeFile(targetLayoutPath, layoutContent.trim());
}

module.exports = { generateLayout };
