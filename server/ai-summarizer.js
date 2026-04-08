const Anthropic = require('@anthropic-ai/sdk');

// Load API key from env file
const fs = require('fs');
const envPath = require('path').join(process.env.HOME, 'agents/.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^export\s+(\w+)=(.+)$/);
    if (match) process.env[match[1]] = match[2];
  });
}

const client = new Anthropic();

const SYSTEM_PROMPT = `你是 MGTY 產品管理處的需求知識助手。你的任務是把搜尋到的原始資料整理成 PM 看得懂的功能說明。

## 核心限制（必須遵守）
1. **只能使用下方提供的搜尋結果來回答**。禁止使用你的預訓練知識來補充任何業務規則、計算公式、功能細節或產品邏輯。
2. **每一條事實描述都必須標註來源**，格式為 [來源: RP/XX站/XX頁] 或 [來源: 知識庫/XX模組] 或 [來源: XX通則/編號XX]。沒有來源的事實不得出現。
3. **所有數字（百分比、金額、天數、次數）必須引用原文**，不得推算或估計。
4. **禁止做否定宣稱**。搜尋結果中未提及 ≠ 不支援。只能說「搜尋結果中未提及」，不能說「不支援」「沒有」「不包含」。
5. 如果某個區塊的搜尋結果不足，直接寫「此部分搜尋結果不足」並跳過，不要硬湊內容。

## 格式規則
- 用繁體中文
- 結構清楚，用標題分段
- 重點先行，不要廢話
- GOR 編號要保留，PM 需要追溯
- 通則引用要標明通則名稱 + 編號（例如「參照篩選條件通則編號 8」）

## 流程圖規則
當搜尋結果中包含多步驟操作流程、頁面跳轉邏輯、或狀態變化時，請用 Mermaid 語法畫流程圖。
- 用 \`\`\`mermaid 包裹
- flowchart 用 TD（上到下）方向
- 節點用中文標籤，保持簡短（10字以內）
- 條件判斷用菱形 {判斷條件?}
- 每個節點後面用註解標來源，格式：%% 來源: RP/XX站/XX頁
- 不要超過 15 個節點，太複雜就拆成多張圖
- 如果搜尋結果中沒有足夠的流程資訊，不要硬畫，跳過即可`;

async function summarizeQuery(query, searchResults, mode) {
  const prompts = {
    logic: buildLogicPrompt,
    feature: buildFeaturePrompt,
    impact: buildImpactPrompt,
    rules: buildRulesPrompt,
  };

  const buildPrompt = prompts[mode] || prompts.logic;
  const userPrompt = buildPrompt(query, searchResults);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const summary = response.content[0].text;

    return {
      summary,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_usd: (response.usage.input_tokens * 3 / 1000000) + (response.usage.output_tokens * 15 / 1000000),
      },
    };
  } catch (error) {
    console.error('AI summarize error:', error.message);
    return {
      summary: `⚠️ AI 整理失敗：${error.message}`,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
  }
}

// ============================================
// Post-validation: check AI output against source data
// ============================================

function validateAIOutput(summary, searchResults, mode) {
  const result = {
    gorCheck: validateGorReferences(summary, searchResults),
    ruleCheck: validateRuleReferences(summary, searchResults),
    sourceStrength: assessSourceStrength(searchResults, mode),
  };

  // Calculate overall confidence
  const phantomCount = result.gorCheck.phantom.length + result.ruleCheck.phantom.length;
  if (result.sourceStrength.empty) {
    result.confidence = 'low';
    result.confidenceMsg = '搜尋結果為空，以下內容可靠度低，請勿直接採用';
  } else if (phantomCount >= 2) {
    result.confidence = 'low';
    result.confidenceMsg = `發現 ${phantomCount} 個無法回溯的編號引用，內容可靠度低`;
  } else if (phantomCount === 1 || result.sourceStrength.thin) {
    result.confidence = 'medium';
    result.confidenceMsg = phantomCount > 0
      ? `發現 ${phantomCount} 個無法回溯的編號引用，已標記`
      : `搜尋命中較少（${result.sourceStrength.hitCount} 筆），建議換關鍵字補充查詢`;
  } else {
    result.confidence = 'high';
    result.confidenceMsg = `所有編號引用均可回溯至資料庫（${result.sourceStrength.hitCount} 筆資料來源）`;
  }

  return result;
}

function validateGorReferences(summary, searchResults) {
  // Extract all GOR-XXXX from AI output
  const aiGors = [...new Set([...summary.matchAll(/GOR-(\d+)/gi)].map(m => `GOR-${m[1]}`))];

  // Collect all GORs that actually exist in search results
  const sourceGors = new Set();

  // From RP page names
  const allPages = [
    ...(searchResults.specifications || []),
    ...(searchResults.rpPages?.byName || []),
    ...(searchResults.rpPages?.byContent || []),
  ];
  // From impact bySite pages
  if (searchResults.bySite) {
    for (const info of Object.values(searchResults.bySite)) {
      (info.pages || []).forEach(p => allPages.push(p));
    }
  }

  allPages.forEach(p => {
    const pageName = p.page || '';
    const matches = pageName.matchAll(/gor-(\d+)/gi);
    for (const m of matches) sourceGors.add(`GOR-${m[1]}`);
  });

  // From gorList
  (searchResults.gorList || []).forEach(g => sourceGors.add(g));

  // From text content (specSamples, samples, matchedLines)
  allPages.forEach(p => {
    const texts = [...(p.specSamples || []), ...(p.samples || [])];
    texts.forEach(t => {
      const matches = t.matchAll(/GOR-(\d+)/gi);
      for (const m of matches) sourceGors.add(`GOR-${m[1]}`);
    });
  });

  // From knowledge base
  (searchResults.knowledgeBase || []).forEach(entry => {
    const lines = entry.matchedLines || [];
    lines.forEach(l => {
      const matches = l.matchAll(/GOR-(\d+)/gi);
      for (const m of matches) sourceGors.add(`GOR-${m[1]}`);
    });
  });

  // From matched rules
  (searchResults.matched || []).forEach(r => {
    const rules = [...(r.matchedRules || []), ...(r.allRules || [])];
    rules.forEach(tr => {
      const matches = (tr.rule || '').matchAll(/GOR-(\d+)/gi);
      for (const m of matches) sourceGors.add(`GOR-${m[1]}`);
    });
  });

  const verified = aiGors.filter(g => sourceGors.has(g));
  const phantom = aiGors.filter(g => !sourceGors.has(g));

  return { total: aiGors.length, verified, phantom };
}

function validateRuleReferences(summary, searchResults) {
  // Extract "編號N" references from AI output
  const ruleRefs = [...new Set([...summary.matchAll(/編號\s*(\d+)/g)].map(m => m[1]))];

  // Collect all rule IDs from search results
  const sourceRuleIds = new Set();
  const allRules = [
    ...(searchResults.rules || []),
    ...(searchResults.matched || []),
  ];
  allRules.forEach(r => {
    const tableRules = [...(r.tableRules || []), ...(r.allRules || []), ...(r.matchedRules || [])];
    tableRules.forEach(tr => {
      if (tr.id) sourceRuleIds.add(String(tr.id));
    });
  });

  const verified = ruleRefs.filter(id => sourceRuleIds.has(id));
  const phantom = ruleRefs.filter(id => !sourceRuleIds.has(id));

  return { total: ruleRefs.length, verified, phantom };
}

function assessSourceStrength(searchResults, mode) {
  let hitCount = 0;

  if (mode === 'logic') {
    hitCount = (searchResults.rules?.length || 0)
      + (searchResults.specifications?.length || 0)
      + (searchResults.knowledgeBase?.length || 0);
  } else if (mode === 'feature') {
    hitCount = (searchResults.knowledgeBase?.length || 0)
      + (searchResults.rpPages?.byName?.length || 0)
      + (searchResults.rpPages?.byContent?.length || 0);
  } else if (mode === 'impact') {
    hitCount = searchResults.totalPages || 0;
  } else if (mode === 'rules') {
    hitCount = searchResults.matched?.length || 0;
  }

  return {
    hitCount,
    empty: hitCount === 0,
    thin: hitCount > 0 && hitCount <= 2,
  };
}

// ============================================
// Prompt builders (restructured output sections)
// ============================================

function buildLogicPrompt(query, data) {
  let context = `PM 想了解「${query}」的核心邏輯。以下是從資料庫搜尋到的原始資料（這是你唯一的資訊來源）：\n\n`;

  if (data.rules && data.rules.length > 0) {
    context += `【通則規則】\n`;
    data.rules.forEach(r => {
      context += `- ${r.name}（來源站台: ${r.site}，被 ${r.refCount} 頁引用）\n`;
      if (r.tableRules) {
        r.tableRules.forEach(tr => context += `  編號${tr.id}：${tr.target} | ${tr.type} | ${tr.rule}\n`);
      }
    });
    context += '\n';
  }

  if (data.knowledgeBase && data.knowledgeBase.length > 0) {
    context += `【知識庫】\n`;
    data.knowledgeBase.slice(0, 8).forEach(e => {
      context += `- [知識庫/${e.module}/${e.title}]\n`;
      if (e.matchedLines) e.matchedLines.slice(0, 5).forEach(l => context += `  ${l}\n`);
    });
    context += '\n';
  }

  if (data.specifications && data.specifications.length > 0) {
    context += `【RP 頁面規格（前 10 筆）】\n`;
    data.specifications.slice(0, 10).forEach(s => {
      context += `- [RP/${s.site}/${s.page}]（${s.matchCount} 處匹配）\n`;
      if (s.specSamples) s.specSamples.slice(0, 3).forEach(t => context += `  「${t.substring(0, 150)}」\n`);
    });
  }

  context += `\n請根據以上搜尋結果，整理成以下格式（每條事實必須標 [來源:...]）：

## 📌 概述
（一句話說明這個功能是什麼）

## 🔧 核心邏輯
（條列式說明核心業務規則、計算方式、觸發條件。每條標來源。）

## 🔄 流程與狀態
（如果搜尋結果中有操作流程或狀態變化，用 mermaid flowchart 或 stateDiagram 畫出來。每個節點標來源註解。搜尋結果不足則跳過。）

## 🚨 邊界情境
（從搜尋結果中提取的例外處理、衝突規則、限制條件。搜尋結果不足則跳過。）

## 🌐 站台差異
（如果搜尋結果涉及多站台，標出差異。搜尋結果不足則跳過。）

## 📋 相關通則
（列出引用了哪些通則、通則名稱 + 編號幾）

## 📜 歷史版本
（如果有 GOR 資訊，按時間列出演變。搜尋結果不足則跳過。）

## ⚠️ 待確認事項
（搜尋結果中不明確或有矛盾的地方，以及資料不足無法確認的部分）`;

  return context;
}

function buildFeaturePrompt(query, data) {
  let context = `PM 想查詢「${query}」相關的功能資訊。以下是搜尋結果（這是你唯一的資訊來源）：\n\n`;

  if (data.knowledgeBase && data.knowledgeBase.length > 0) {
    context += `【知識庫】\n`;
    data.knowledgeBase.slice(0, 8).forEach(e => {
      context += `- [知識庫/${e.module}/${e.title}]：${e.snippet || ''}\n`;
    });
    context += '\n';
  }

  if (data.rpPages) {
    if (data.rpPages.byName && data.rpPages.byName.length > 0) {
      context += `【RP 檔名命中（${data.rpPages.byName.length} 頁）】\n`;
      data.rpPages.byName.slice(0, 10).forEach(p => context += `- [RP/${p.site}/${p.page}]\n`);
      context += '\n';
    }
    if (data.rpPages.byContent && data.rpPages.byContent.length > 0) {
      context += `【RP 內容命中（${data.rpPages.byContent.length} 頁，列前 8）】\n`;
      data.rpPages.byContent.slice(0, 8).forEach(p => {
        context += `- [RP/${p.site}/${p.page}]（${p.matchCount} 匹配）\n`;
        if (p.samples) p.samples.forEach(s => context += `  「${s}」\n`);
      });
      context += '\n';
    }
  }

  if (data.gorList && data.gorList.length > 0) {
    context += `【相關 GOR 編號】\n${data.gorList.join(', ')}\n`;
  }

  context += `\n請根據以上搜尋結果，整理成以下格式（每條事實必須標 [來源:...]）：

## 📌 功能概述
（這個功能是什麼、在產品中的位置）

## 🗂️ 涵蓋範圍
（涉及哪些站台、哪些頁面模組，用表格呈現）

## 📝 關鍵規格
（從 RP 內容中提取的重要規則和設定）

## 🔄 操作流程
（如果搜尋結果中有操作步驟或頁面跳轉邏輯，用 mermaid flowchart 畫出來。搜尋結果不足則跳過。）

## 🔗 相關 GOR
（列出 GOR 編號和對應的功能描述。只列搜尋結果中出現的。）

## ⚠️ 待確認事項
（資料不足或不明確的部分）`;

  return context;
}

function buildImpactPrompt(query, data) {
  let context = `PM 想了解「${query}」的影響範圍。以下是搜尋結果（這是你唯一的資訊來源）：\n\n`;

  context += `影響頁面總數：${data.totalPages}\n`;
  context += `跨站台數：${Object.keys(data.bySite || {}).length}\n`;
  context += `涉及知識庫模組：${(data.affectedModules || []).join(', ') || '無'}\n\n`;

  if (data.bySite) {
    for (const [site, info] of Object.entries(data.bySite)) {
      context += `【${site}（${info.count} 頁）】\n`;
      info.pages.slice(0, 8).forEach(p => {
        context += `- [RP/${site}/${p.page}] ${p.isNameMatch ? '（檔名命中）' : '（內容命中）'}${p.matchCount > 0 ? `（${p.matchCount} 匹配）` : ''}\n`;
      });
      if (info.count > 8) context += `  ... 還有 ${info.count - 8} 頁\n`;
      context += '\n';
    }
  }

  context += `\n請根據以上搜尋結果，整理成以下格式：

## 📊 影響總覽
（一句話概括影響範圍大小，引用實際數字）

## 🏢 各站台影響
（用表格列出每個站台被影響的頁面數量和代表性頁面）

## ⚠️ 高風險區域
（影響集中在哪些模組，哪些是核心頁面。只根據搜尋結果中的頁面名稱判斷，不要推測。）

## 🔗 跨模組關聯
（根據搜尋結果分析跨站台/模組的關聯性。搜尋結果不足則跳過。）

## ⚠️ 待確認事項
（影響範圍可能不完整的地方，建議補充查詢的方向）`;

  return context;
}

function buildRulesPrompt(query, data) {
  let context = `PM 想查詢通則規格「${query}」。以下是搜尋結果（這是你唯一的資訊來源）：\n\n`;

  if (data.matched && data.matched.length > 0) {
    data.matched.forEach(r => {
      context += `【${r.name}】來源站台：${r.site}，被 ${r.refCount} 頁引用\n`;
      const rules = r.matchedRules && r.matchedRules.length > 0 ? r.matchedRules : r.allRules;
      if (rules) {
        rules.forEach(tr => context += `  編號${tr.id}：${tr.target} | ${tr.type} | ${tr.rule}\n`);
      }
      context += '\n';
    });
  }

  context += `\n請根據以上搜尋結果，整理成以下格式（每條規則必須標來源通則名稱）：

## 📐 通則說明
（這個通則是什麼、用在哪裡）

## 📋 規則明細
（用表格清楚列出每條規則，欄位：編號、適用對象、元件類型、規則說明。只列搜尋結果中有的。）

## 💡 使用指引
（PM 在寫需求時怎麼引用這個通則）

## ⚠️ 待確認事項
（搜尋結果不足或不明確的部分）`;

  return context;
}

module.exports = { summarizeQuery, validateAIOutput };
