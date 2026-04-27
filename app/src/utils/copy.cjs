// src/utils/copy.cjs
const fs = require('fs-extra');
const path = require('path');
const ora = require('ora');

async function cloneProject(source, destination) {
  const spinner = ora('프로젝트를 복제하는 중...').start();

  try {
    await fs.copy(source, destination, {
      filter: (src) => {
        // 복사 제외 폴더 목록
        if (
          src.includes('node_modules') ||
          src.includes('.git') ||
          src.includes('.next') ||
          src.includes('dist') ||
          src.includes('.nextify')
        ) {
          return false;
        }
        return true;
      },
    });
    
    // .gitignore 파일을 명시적으로 복사 (기존 내용 유지 보장)
    const sourceGitignore = path.join(source, '.gitignore');
    const destGitignore = path.join(destination, '.gitignore');
    if (fs.existsSync(sourceGitignore)) {
      // 원본 .gitignore가 있으면 항상 복사 (기존 내용 보존)
      await fs.copy(sourceGitignore, destGitignore, { overwrite: true });
    }
    
    spinner.succeed(`프로젝트 복제 완료: ${destination}`);
  } catch (e) {
    spinner.fail('프로젝트 복제 실패');
    throw e;
  }
}

module.exports = { cloneProject };
