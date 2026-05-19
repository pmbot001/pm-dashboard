const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

if (process.env.HOME) {
  const envPath = path.join(process.env.HOME, 'agents/.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
      const m = line.match(/^export\s+(\w+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  }
}

const USE_LLM = process.env.MINA_USE_LLM === '1';
const llmClient = (USE_LLM && process.env.ANTHROPIC_API_KEY) ? new Anthropic() : null;
const MODEL = 'claude-haiku-4-5-20251001';

const judgmentCache = new Map();

// ---------- Heuristic classifier ----------

const KW_BROADCAST = /!channel|<!channel>|@channel|<!here>|!here/i;
const KW_SCHEDULE = /人力安排|sprint|排程|派單|工單|加班|休假|請假|代理|出差|cut.?off/i;
const KW_REQUIREMENT = /需求|規格|RP|Figma|axshare|邏輯|文案|跑版|錯字|UI|UX|介面|按鈕|彈窗|跳轉|樣式|顯示|畫面/i;
const KW_TECH = /API|endpoint|資料庫|database|前端|後端|backend|frontend|debug|報錯|exception|error|log|deploy/i;
const KW_QUESTION = /嗎\?|嗎？|呢\?|呢？|嗎$|呢$|可以不|可以嗎|對嗎|是嗎|請問|請教|麻煩|確認|幫忙看|請幫|看一下/;

function heuristicJudgment(mention) {
  const text = mention.fullText || mention.text || '';
  const askerName = mention.asker?.name || '';

  if (KW_BROADCAST.test(text)) {
    return { needsReply: false, category: '排程廣播', reason: '含 !channel 廣播', confidence: 'high', source: 'heuristic' };
  }

  const tagMatches = text.match(/@TPE[^\s@,，。]+/g) || [];
  const uniqueTags = [...new Set(tagMatches.map(t => t.replace(/[.,，。!?]+$/, '')))];
  if (uniqueTags.length >= 4) {
    return { needsReply: false, category: '排程廣播', reason: `多人 tag (${uniqueTags.length} 位)`, confidence: 'medium', source: 'heuristic' };
  }

  if (KW_SCHEDULE.test(text)) {
    return { needsReply: false, category: '排程/人力', reason: '排程/人力相關（PM 主管領域）', confidence: 'medium', source: 'heuristic' };
  }

  if (askerName.includes('Claire')) {
    return { needsReply: false, category: '排程廣播', reason: 'Claire（PM 主管）通常為廣播', confidence: 'medium', source: 'heuristic' };
  }

  if (KW_REQUIREMENT.test(text)) {
    return { needsReply: true, category: '需求問題', reason: '含需求 / RP / Figma 等關鍵字', confidence: 'medium', source: 'heuristic' };
  }

  if (KW_QUESTION.test(text)) {
    return { needsReply: true, category: '需求問題', reason: '疑問句，預設視為需求確認', confidence: 'low', source: 'heuristic' };
  }

  if (KW_TECH.test(text) && !KW_REQUIREMENT.test(text)) {
    return { needsReply: false, category: '技術問題', reason: '純技術用語、無需求關鍵字', confidence: 'low', source: 'heuristic' };
  }

  return { needsReply: true, category: '其他', reason: '無明確訊號，保守視為需處理', confidence: 'low', source: 'heuristic' };
}

// ---------- LLM classifier (optional, off by default) ----------

const PROMPT = `你的任務：判斷一則 Slack 訊息是否需要 Mina（NWC 專案 PM）親自處理。

Mina 職責：
- ✅ 需求 / RP / Figma / 規格 / 業務邏輯
- ❌ 不負責：Sprint 排程、人力安排（那是 Claire 的事）
- ❌ 不負責：技術實作細節

規則：
1. 訊息問需求 / 規格 / RP / 邏輯 → needsReply=true
2. !channel / 廣播且 Mina 只是 cc → needsReply=false
3. 排程 / 人力 / PM 內部協調 → needsReply=false
4. 純技術問題 → needsReply=false
5. 不明確時保守 → needsReply=true

發問者：{ASKER}
訊息：
"""
{TEXT}
"""

只回 JSON：
{"needsReply":true|false,"category":"需求問題|RP/Figma|排程廣播|人力安排|技術問題|其他","reason":"20字內","confidence":"high|medium|low"}`;

function parseLlmResponse(raw) {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.needsReply !== 'boolean') return null;
    return {
      needsReply: o.needsReply,
      category: String(o.category || '其他'),
      reason: String(o.reason || '').slice(0, 60),
      confidence: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'medium',
      source: 'llm',
    };
  } catch { return null; }
}

async function llmJudgment(mention) {
  const text = (mention.fullText || mention.text || '').slice(0, 1500);
  const prompt = PROMPT.replace('{ASKER}', mention.asker?.name || 'Unknown').replace('{TEXT}', text);
  const resp = await llmClient.messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseLlmResponse(resp.content?.[0]?.text || '');
}

// ---------- Public API ----------

async function classifyOne(mention) {
  if (judgmentCache.has(mention.ts)) return judgmentCache.get(mention.ts);

  let judgment = null;
  if (llmClient) {
    try {
      judgment = await llmJudgment(mention);
    } catch (e) {
      console.error(`LLM classify failed for ts=${mention.ts}: ${e.message?.slice(0, 80)}`);
    }
  }
  if (!judgment) judgment = heuristicJudgment(mention);

  judgmentCache.set(mention.ts, judgment);
  return judgment;
}

async function classifyMentions(mentions) {
  const targets = mentions.filter(m => m.status !== 'closed');
  await Promise.all(targets.map(m => classifyOne(m)));
  return mentions.map(m => ({
    ...m,
    aiJudgment: m.status === 'closed' ? null : (judgmentCache.get(m.ts) || null),
  }));
}

module.exports = { classifyMentions, judgmentCache };
