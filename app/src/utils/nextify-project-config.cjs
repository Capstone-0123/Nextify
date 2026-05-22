'use strict';

/**
 * 마이그레이션 대상 프로젝트 루트의 선택적 `.nextify/*.json` (저장소에 커밋 안 해도 됨).
 */

const fs = require('fs-extra');
const path = require('path');

const DEFAULT_GEMINI_TSX_SUBDIRS = [
  'src/app',
  'src/pages',
  'src/components',
  'src/widgets',
  'src/features',
  'src/views',
  'src/modules',
  'src/sections',
  'src/routes',
];

/** default import 시 dynamic() 후보로 삼을 무거운 패키지 (package.json 이름 기준) */
const DEFAULT_HEAVY_DEFAULT_IMPORT_PACKAGES = [
  '@monaco-editor/react',
  'react-quill',
  'react-player',
  'react-pdf',
  'react-apexcharts',
  'apexcharts',
];

/**
 * @param {string} projectRoot
 * @returns {{
 *   imageUrlHostHints: string[],
 *   geminiTsxSubdirs: string[],
 *   lcpImageFilenameBaseNames: string[],
 *   heavyDefaultImportPackages: string[],
 * }}
 */
function loadNextifyProjectConfig(projectRoot) {
  const out = {
    imageUrlHostHints: [],
    geminiTsxSubdirs: [...DEFAULT_GEMINI_TSX_SUBDIRS],
    lcpImageFilenameBaseNames: ['Home', 'Hero', 'Banner', 'Landing'],
    heavyDefaultImportPackages: [...DEFAULT_HEAVY_DEFAULT_IMPORT_PACKAGES],
  };

  const dir = path.join(projectRoot, '.nextify');
  if (!fs.existsSync(dir)) {
    return out;
  }

  for (const name of ['nextify.config.json', 'step6.config.json']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    let j;
    try {
      j = fs.readJsonSync(p);
    } catch {
      continue;
    }
    if (!j || typeof j !== 'object') continue;

    if (Array.isArray(j.imageUrlHostHints)) {
      for (const h of j.imageUrlHostHints) {
        if (typeof h === 'string' && h.trim()) out.imageUrlHostHints.push(h.trim());
      }
    }
    if (Array.isArray(j.geminiTsxSubdirs) && j.geminiTsxSubdirs.length > 0) {
      out.geminiTsxSubdirs = j.geminiTsxSubdirs
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''));
    }
    if (Array.isArray(j.lcpImageFilenameBaseNames) && j.lcpImageFilenameBaseNames.length > 0) {
      out.lcpImageFilenameBaseNames = j.lcpImageFilenameBaseNames
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim());
    }
    if (Array.isArray(j.heavyDefaultImportPackages)) {
      for (const p of j.heavyDefaultImportPackages) {
        if (typeof p === 'string' && p.trim()) out.heavyDefaultImportPackages.push(p.trim());
      }
      out.heavyDefaultImportPackages = [...new Set(out.heavyDefaultImportPackages)];
    }
  }

  return out;
}

module.exports = {
  loadNextifyProjectConfig,
  DEFAULT_GEMINI_TSX_SUBDIRS,
  DEFAULT_HEAVY_DEFAULT_IMPORT_PACKAGES,
};
