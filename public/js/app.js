// State
let currentMode = 'logic';

// DOM
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const resultsDiv = document.getElementById('results');
const statsDiv = document.getElementById('stats');
const modeTabs = document.querySelectorAll('.mode-tab');
const quickTags = document.querySelectorAll('.tag');

// Init
async function init() {
  const res = await fetch('/api/stats');
  const stats = await res.json();
  statsDiv.textContent = `RP ${stats.rpPages} 頁 | ${stats.rpTextBlocks.toLocaleString()} 文字區塊 | KB ${stats.knowledgeBaseEntries} 條 | 通則 ${stats.designRules} 個`;
}
init();

// Events
searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

modeTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    modeTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentMode = tab.dataset.mode;
    if (searchInput.value.trim()) doSearch();
  });
});

quickTags.forEach(tag => {
  tag.addEventListener('click', () => {
    searchInput.value = tag.dataset.query;
    const mode = tag.dataset.mode;
    modeTabs.forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-mode="${mode}"]`).classList.add('active');
    currentMode = mode;
    doSearch();
  });
});

// Search (AI-powered)
async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;

  searchBtn.disabled = true;
  resultsDiv.innerHTML = `<div class="loading">
    <div class="loading-spinner"></div>
    <div>AI 整理中，請稍候...</div>
  </div>`;

  try {
    const res = await fetch(`/api/ai/${currentMode}?q=${encodeURIComponent(q)}`);
    const data = await res.json();

    if (data.error) {
      resultsDiv.innerHTML = `<div class="empty-state"><p>⚠️ ${esc(data.error)}</p></div>`;
      return;
    }

    renderAIResult(data);
  } catch (err) {
    resultsDiv.innerHTML = `<div class="empty-state"><p>⚠️ 連線錯誤：${esc(err.message)}</p></div>`;
  } finally {
    searchBtn.disabled = false;
  }
}

// Render AI result
function renderAIResult(data) {
  let html = '';

  // Meta bar
  html += `<div class="summary-bar">
    <div class="summary-item"><span class="summary-label">查詢</span><span class="summary-value">${esc(data.query)}</span></div>`;

  const meta = data.searchMeta;
  if (data.mode === 'logic') {
    html += metaItem('通則', meta.rules);
    html += metaItem('RP 規格', meta.specs);
    html += metaItem('知識庫', meta.kb);
  } else if (data.mode === 'feature') {
    html += metaItem('知識庫', meta.kb);
    html += metaItem('RP 頁面', meta.rpName + meta.rpContent);
    html += metaItem('GOR', meta.gor);
  } else if (data.mode === 'impact') {
    html += metaItem('影響頁面', meta.totalPages);
    html += metaItem('跨站台', meta.sites);
    html += metaItem('涉及模組', meta.modules);
  } else if (data.mode === 'rules') {
    html += metaItem('命中通則', meta.matched);
  }

  // Coverage rate
  if (data.totalRpPages && data.mode === 'impact' && meta.totalPages) {
    const pct = ((meta.totalPages / data.totalRpPages) * 100).toFixed(1);
    html += `<div class="summary-item"><span class="summary-label">覆蓋率</span><span class="summary-value">${pct}%</span></div>`;
  }

  html += `</div>`;

  // Confidence badge
  if (data.validation) {
    const v = data.validation;
    const colorMap = { high: '#16a34a', medium: '#d97706', low: '#dc2626' };
    const iconMap = { high: '✅', medium: '⚠️', low: '🔴' };
    html += `<div class="confidence-bar confidence-${v.confidence}" style="--conf-color: ${colorMap[v.confidence]}">
      <span class="confidence-icon">${iconMap[v.confidence]}</span>
      <span class="confidence-label">可信度：</span>
      <span class="confidence-msg">${esc(v.confidenceMsg)}</span>
    </div>`;
  }

  // AI Summary card
  html += `<div class="ai-summary-card">
    <div class="ai-summary-header">
      <span class="ai-badge">✨ AI 整理</span>
      <span class="ai-cost">tokens: ${data.usage.input_tokens + data.usage.output_tokens} | ~$${data.usage.cost_usd.toFixed(4)}</span>
    </div>
    <div class="ai-summary-body markdown-body">${renderMarkdown(data.summary, data.validation)}</div>
  </div>`;

  // Raw data panel (collapsible)
  if (data.rawPreview && data.rawPreview.length > 0) {
    html += `<div class="raw-panel">
      <button class="raw-toggle" onclick="this.parentElement.classList.toggle('open')">
        📋 查看原始搜尋結果（${data.rawPreview.length} 筆）
        <span class="raw-arrow">▶</span>
      </button>
      <div class="raw-content">
        <table class="raw-table">
          <thead><tr><th>類型</th><th>名稱</th><th>站台</th><th>匹配</th></tr></thead>
          <tbody>${data.rawPreview.map(r => `<tr>
            <td><span class="badge badge-${typeBadge(r.type)}">${esc(r.type)}</span></td>
            <td>${esc(r.label)}</td>
            <td>${esc(r.site || '-')}</td>
            <td>${r.matchCount || r.ruleCount || '-'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  resultsDiv.innerHTML = html;

  // Render Mermaid diagrams
  renderMermaidBlocks();
}

async function renderMermaidBlocks() {
  const blocks = document.querySelectorAll('.mermaid-pending');
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const code = block.textContent;
    try {
      const id = `mermaid-${Date.now()}-${i}`;
      const { svg } = await mermaid.render(id, code);
      block.innerHTML = svg;
      block.classList.remove('mermaid-pending');
      block.classList.add('mermaid-rendered');
    } catch (err) {
      console.warn('Mermaid render failed:', err);
      block.innerHTML = `<pre class="mermaid-error"><code>${esc(code)}</code></pre><div class="mermaid-error-msg">⚠️ 流程圖語法錯誤，顯示原始碼</div>`;
      block.classList.remove('mermaid-pending');
    }
  }
}

function metaItem(label, value) {
  return `<div class="summary-item"><span class="summary-label">${label}</span><span class="summary-value">${value}</span></div>`;
}

function typeBadge(type) {
  if (type.includes('RP')) return 'site';
  if (type.includes('通則')) return 'ref';
  if (type.includes('知識庫')) return 'name';
  return 'content';
}

// Markdown renderer with phantom highlighting
function renderMarkdown(md, validation) {
  if (!md) return '';

  // Extract mermaid blocks BEFORE escaping (they contain special chars)
  const mermaidBlocks = [];
  let processed = md.replace(/```mermaid\n([\s\S]*?)```/g, (match, code) => {
    const idx = mermaidBlocks.length;
    mermaidBlocks.push(code.trim());
    return `%%MERMAID_${idx}%%`;
  });

  let html = esc(processed);

  // Re-inject mermaid blocks as rendered containers
  mermaidBlocks.forEach((code, idx) => {
    html = html.replace(
      `%%MERMAID_${idx}%%`,
      `<div class="mermaid-container"><div class="mermaid-pending">${code}</div></div>`
    );
  });

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold & italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Source tags — style them as small badges
  html = html.replace(/\[來源:\s*([^\]]+)\]/g, '<span class="source-tag" title="$1">📎 $1</span>');

  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)*)/gm, (match, headerRow, sepRow, bodyRows) => {
    const headers = headerRow.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = bodyRows.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table class="md-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up
  html = html.replace(/<p>\s*<(h[123]|ul|table)/g, '<$1');
  html = html.replace(/<\/(h[123]|ul|table)>\s*<\/p>/g, '</$1>');
  html = html.replace(/<p>\s*<\/p>/g, '');

  // Highlight phantom references
  if (validation) {
    const phantomGors = validation.gorCheck?.phantom || [];
    phantomGors.forEach(gor => {
      html = html.replace(
        new RegExp(escRegex(gor), 'g'),
        `<span class="phantom-ref" title="此 GOR 編號在搜尋結果中不存在，可能為 AI 推測">${gor}</span>`
      );
    });

    const phantomRules = validation.ruleCheck?.phantom || [];
    phantomRules.forEach(id => {
      // Only highlight "編號X" pattern to avoid false positives
      html = html.replace(
        new RegExp(`編號\\s*${escRegex(id)}(?!\\d)`, 'g'),
        `<span class="phantom-ref" title="此通則編號在搜尋結果中不存在，可能為 AI 推測">編號${id}</span>`
      );
    });
  }

  return html;
}

// Helpers
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchRule(name) {
  searchInput.value = name;
  doSearch();
}
