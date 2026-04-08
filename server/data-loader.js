const fs = require('fs');
const path = require('path');

const PRODUCT_DATA = path.join(process.env.HOME, '.claude/shared-references/product-data');

function loadAllData() {
  return {
    rpPages: loadRpIndex(),
    knowledgeBase: loadKnowledgeBase(),
    designRules: loadDesignRules(),
    rpSiteIndex: loadFile(path.join(PRODUCT_DATA, 'rp-site-index.md')),
    figmaIndex: loadFile(path.join(PRODUCT_DATA, 'kiwi-figma-index.md')),
  };
}

// RP full-text index
function loadRpIndex() {
  const filePath = path.join(PRODUCT_DATA, 'features/rp-screens/rp-fulltext-index.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// Knowledge base: parse each module .md file
function loadKnowledgeBase() {
  const featuresDir = path.join(PRODUCT_DATA, 'features');
  const files = fs.readdirSync(featuresDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'design-rules.md' && f !== 'feature-knowledge-base.md');

  const entries = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(featuresDir, file), 'utf-8');
    const moduleName = extractModuleName(file, content);

    // Split by ## headings to get sections
    const sections = content.split(/^## /m).filter(Boolean);
    for (const section of sections) {
      const lines = section.split('\n');
      const title = lines[0].trim();
      const body = lines.slice(1).join('\n').trim();
      if (title && body && !title.startsWith('#')) {
        entries.push({
          module: moduleName,
          file,
          title,
          body,
          bodyLower: body.toLowerCase(),
          titleLower: title.toLowerCase(),
        });
      }
    }
  }

  // Also load feature-knowledge-base.md
  const fkbPath = path.join(featuresDir, 'feature-knowledge-base.md');
  if (fs.existsSync(fkbPath)) {
    const content = fs.readFileSync(fkbPath, 'utf-8');
    const sections = content.split(/^## /m).filter(Boolean);
    for (const section of sections) {
      const lines = section.split('\n');
      const title = lines[0].trim();
      const body = lines.slice(1).join('\n').trim();
      if (title && body) {
        entries.push({
          module: '功能知識庫',
          file: 'feature-knowledge-base.md',
          title,
          body,
          bodyLower: body.toLowerCase(),
          titleLower: title.toLowerCase(),
        });
      }
    }
  }

  return entries;
}

function extractModuleName(file, content) {
  // Try first heading
  const match = content.match(/^# (.+)/m);
  if (match) return match[1].replace(/[#\s]+$/, '').trim();
  // Fallback to filename
  return file.replace('.md', '');
}

// Design rules
function loadDesignRules() {
  const filePath = path.join(PRODUCT_DATA, 'features/design-rules.md');
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const rules = [];

  // Parse the numbered rule sections (## 1. 篩選條件通則, etc.)
  const sections = content.split(/^## \d+\. /m).filter(Boolean);

  // Skip the first section (header/overview)
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const lines = section.split('\n');
    const name = lines[0].trim();
    const body = lines.slice(1).join('\n').trim();

    // Extract individual rules from tables
    const tableRules = [];
    const tableRegex = /\| (\d+)\s*\|([^|]+)\|([^|]+)\|([^|]+)\|/g;
    let m;
    while ((m = tableRegex.exec(body)) !== null) {
      tableRules.push({
        id: m[1].trim(),
        target: m[2].trim(),
        type: m[3].trim(),
        rule: m[4].trim(),
      });
    }

    // Extract reference count
    const refMatch = body.match(/被引用[：:]\s*(\d+)\s*頁/);
    const refCount = refMatch ? parseInt(refMatch[1]) : 0;

    // Extract site info
    const siteMatch = body.match(/來源站台[：:]\s*(.+)/);
    const site = siteMatch ? siteMatch[1].trim() : '';

    rules.push({
      name,
      body,
      bodyLower: body.toLowerCase(),
      nameLower: name.toLowerCase(),
      tableRules,
      refCount,
      site,
    });
  }

  // Also parse P2 list
  const p2Match = content.match(/## P2 通則清單[\s\S]*?\n(\|[\s\S]*?\n)(?=\n>|\n$|$)/);
  if (p2Match) {
    const p2Regex = /\| \d+\s*\|([^|]+)\|([^|]+)\|([^|]*)\|/g;
    let m;
    while ((m = p2Regex.exec(p2Match[1])) !== null) {
      const name = m[1].trim();
      const site = m[2].trim();
      const refs = m[3].trim();
      rules.push({
        name,
        body: `所屬站台：${site}\n被引用：${refs || '—'}`,
        bodyLower: name.toLowerCase(),
        nameLower: name.toLowerCase(),
        tableRules: [],
        refCount: refs === '—' ? 0 : parseInt(refs) || 0,
        site,
        isP2: true,
      });
    }
  }

  return rules;
}

function loadFile(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

module.exports = { loadAllData };
