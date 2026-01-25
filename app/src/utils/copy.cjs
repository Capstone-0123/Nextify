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
        if (src.includes('node_modules') || src.includes('.git') || src.includes('.next') || src.includes('dist')) {
          return false;
        }
        return true;
      },
    });
    spinner.succeed(`프로젝트 복제 완료: ${destination}`);
  } catch (e) {
    spinner.fail('프로젝트 복제 실패');
    throw e;
  }
}

module.exports = { cloneProject };
