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

  // 「其他問題」的訊號優先判斷（high confidence first）
  if (KW_BROADCAST.test(text)) {
    return { category: '其他問題', reason: '含 !channel 廣播', confidence: 'high', source: 'heuristic' };
  }
  const tagMatches = text.match(/@TPE[^\s@,，。]+/g) || [];
  const uniqueTags = [...new Set(tagMatches.map(t => t.replace(/[.,，。!?]+$/, '')))];
  if (uniqueTags.length >= 4) {
    return { category: '其他問題', reason: `多人 tag (${uniqueTags.length} 位）`, confidence: 'medium', source: 'heuristic' };
  }
  if (KW_SCHEDULE.test(text)) {
    return { category: '其他問題', reason: '排程 / 人力相關', confidence: 'medium', source: 'heuristic' };
  }
  if (askerName.includes('Claire')) {
    return { category: '其他問題', reason: 'Claire 發起，多為 PM 內部協調', confidence: 'medium', source: 'heuristic' };
  }
  if (KW_TECH.test(text) && !KW_REQUIREMENT.test(text)) {
    return { category: '其他問題', reason: '純技術用語、無業務關鍵字', confidence: 'low', source: 'heuristic' };
  }

  // 預設「需求問題」（給 Mina 看到再判斷較保守）
  if (KW_REQUIREMENT.test(text)) {
    return { category: '需求問題', reason: '含需求 / RP / Figma 等關鍵字', confidence: 'medium', source: 'heuristic' };
  }
  return { category: '需求問題', reason: '預設視為需求確認', confidence: 'low', source: 'heuristic' };
}

// ---------- LLM classifier (optional, off by default) ----------

const PROMPT = `你的任務：把一則 Slack 訊息分類為「需求問題」或「其他問題」。

定義：
- 需求問題 = 在問規格 / RP / Figma / 業務邏輯 / 文案 / UI 樣式（Mina 的領域）
- 其他問題 = 其他全部（廣播、排程、人力、技術實作、純通知）

發問者：{ASKER}
訊息：
"""
{TEXT}
"""

只回 JSON：
{"category":"需求問題|其他問題","reason":"20字內","confidence":"high|medium|low"}`;

function parseLlmResponse(raw) {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const cat = String(o.category || '其他問題');
    if (cat !== '需求問題' && cat !== '其他問題') return null;
    return {
      category: cat,
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
  await Promise.all(mentions.map(m => classifyOne(m)));
  return mentions.map(m => ({
    ...m,
    aiJudgment: judgmentCache.get(m.ts) || null,
  }));
}

module.exports = { classifyMentions, judgmentCache };
