const express = require('express');
const { summarizeQuery, validateAIOutput } = require('./ai-summarizer');

function createSearchRouter(data) {
  const router = express.Router();

  // Expand keywords: simplified <-> traditional Chinese common pairs
  const SYNONYM_MAP = {
    '轉盤': ['转盘', '轉盤', 'spin wheel', 'wheel'],
    '转盘': ['转盘', '轉盤', 'spin wheel', 'wheel'],
    '佣金': ['佣金', 'commission'],
    '充值': ['充值', '充值', 'deposit', 'recharge'],
    '提款': ['提款', '提现', 'withdrawal'],
    '提现': ['提款', '提现', 'withdrawal'],
    '會員': ['会员', '會員', 'member'],
    '会员': ['会员', '會員', 'member'],
    '紅利': ['红利', '紅利', 'bonus'],
    '红利': ['红利', '紅利', 'bonus'],
    '投注': ['投注', '下注', 'bet', 'wager'],
    '下注': ['投注', '下注', 'bet', 'wager'],
    '返水': ['返水', 'rebate'],
    '代理': ['代理', 'agent', 'proxy'],
  };

  function expandKeywords(query) {
    const q = query.trim().toLowerCase();
    const keywords = [q];
    // Check synonyms
    for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
      if (q.includes(key.toLowerCase())) {
        synonyms.forEach(s => {
          if (!keywords.includes(s.toLowerCase())) keywords.push(s.toLowerCase());
        });
      }
    }
    return keywords;
  }

  function matchesAny(text, keywords) {
    const lower = text.toLowerCase();
    return keywords.some(kw => lower.includes(kw));
  }

  // ============================================
  // P1: Core Logic Query
  // ============================================
  router.get('/logic', (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ error: 'Missing query parameter q' });

    const keywords = expandKeywords(q);
    const results = {
      query: q,
      keywords,
      mode: 'core-logic',
      rules: [],        // Matching design rules
      specifications: [], // RP pages with detailed specs
      knowledgeBase: [], // KB entries
    };

    // 1. Search design rules
    for (const rule of data.designRules) {
      if (matchesAny(rule.name, keywords) || matchesAny(rule.body, keywords)) {
        results.rules.push({
          name: rule.name,
          site: rule.site,
          refCount: rule.refCount,
          isP2: rule.isP2 || false,
          tableRules: rule.tableRules.filter(tr =>
            matchesAny(tr.target, keywords) || matchesAny(tr.rule, keywords) || matchesAny(tr.type, keywords)
          ),
          allRules: rule.tableRules,
        });
      }
    }

    // 2. Search RP for spec-like content (filter for pages with more detailed text)
    const rpHits = [];
    for (const page of data.rpPages) {
      const matchedTexts = page.texts.filter(t => matchesAny(t, keywords));
      if (matchedTexts.length > 0) {
        // Prioritize pages with longer, rule-like text
        const specTexts = matchedTexts.filter(t => t.length > 30);
        if (specTexts.length > 0) {
          rpHits.push({
            site: page.site,
            page: page.page,
            file: page.file,
            matchCount: matchedTexts.length,
            specSamples: specTexts.slice(0, 3),
          });
        }
      }
    }
    rpHits.sort((a, b) => b.matchCount - a.matchCount);
    results.specifications = rpHits.slice(0, 20);

    // 3. Search knowledge base
    for (const entry of data.knowledgeBase) {
      if (matchesAny(entry.title, keywords) || matchesAny(entry.body, keywords)) {
        const bodyLines = entry.body.split('\n').filter(l => matchesAny(l, keywords));
        results.knowledgeBase.push({
          module: entry.module,
          title: entry.title,
          matchedLines: bodyLines.slice(0, 5),
        });
      }
    }

    res.json(results);
  });

  // ============================================
  // P2: Feature Query
  // ============================================
  router.get('/feature', (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ error: 'Missing query parameter q' });

    const keywords = expandKeywords(q);
    const results = {
      query: q,
      keywords,
      mode: 'feature',
      knowledgeBase: [],
      rpPages: { byName: [], byContent: [] },
      gorList: [],
    };

    // 1. Knowledge base
    for (const entry of data.knowledgeBase) {
      if (matchesAny(entry.title, keywords) || matchesAny(entry.body, keywords)) {
        results.knowledgeBase.push({
          module: entry.module,
          title: entry.title,
          snippet: entry.body.substring(0, 200),
        });
      }
    }

    // 2. RP pages - split by name match vs content match
    for (const page of data.rpPages) {
      const nameMatch = matchesAny(page.page, keywords);
      const contentMatches = page.texts.filter(t => matchesAny(t, keywords));

      if (nameMatch) {
        results.rpPages.byName.push({
          site: page.site,
          page: page.page,
          file: page.file,
          contentMatchCount: contentMatches.length,
        });
      } else if (contentMatches.length > 0) {
        results.rpPages.byContent.push({
          site: page.site,
          page: page.page,
          file: page.file,
          matchCount: contentMatches.length,
          samples: contentMatches.slice(0, 2).map(t => t.substring(0, 100)),
        });
      }
    }

    // Sort content matches by match count
    results.rpPages.byContent.sort((a, b) => b.matchCount - a.matchCount);
    results.rpPages.byContent = results.rpPages.byContent.slice(0, 30);

    // 3. GOR list from RP page names
    const gorSet = new Set();
    [...results.rpPages.byName, ...results.rpPages.byContent].forEach(p => {
      const gorMatch = p.page.match(/gor-(\d+)/i);
      if (gorMatch) gorSet.add(`GOR-${gorMatch[1]}`);
    });
    results.gorList = [...gorSet].sort();

    res.json(results);
  });

  // ============================================
  // P3: Impact Analysis
  // ============================================
  router.get('/impact', (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ error: 'Missing query parameter q' });

    const keywords = expandKeywords(q);
    const results = {
      query: q,
      keywords,
      mode: 'impact',
      totalPages: 0,
      bySite: {},
      crossModule: [],
    };

    // Search all RP pages
    for (const page of data.rpPages) {
      const matchedTexts = page.texts.filter(t => matchesAny(t, keywords));
      if (matchedTexts.length === 0 && !matchesAny(page.page, keywords)) continue;

      const siteName = page.site;
      if (!results.bySite[siteName]) {
        results.bySite[siteName] = { count: 0, pages: [] };
      }
      results.bySite[siteName].count++;
      results.totalPages++;

      if (results.bySite[siteName].pages.length < 15) {
        results.bySite[siteName].pages.push({
          page: page.page,
          file: page.file,
          matchCount: matchedTexts.length,
          isNameMatch: matchesAny(page.page, keywords),
        });
      }
    }

    // Cross-module: if multiple sites are affected
    const sites = Object.keys(results.bySite);
    if (sites.length > 1) {
      results.crossModule = sites.map(s => ({
        site: s,
        count: results.bySite[s].count,
      }));
    }

    // Check knowledge base for cross-references
    const kbModules = new Set();
    for (const entry of data.knowledgeBase) {
      if (matchesAny(entry.title, keywords) || matchesAny(entry.body, keywords)) {
        kbModules.add(entry.module);
      }
    }
    results.affectedModules = [...kbModules];

    res.json(results);
  });

  // ============================================
  // P4: Design Rules Lookup
  // ============================================
  router.get('/rules', (req, res) => {
    const q = req.query.q;

    // No query = return all rules overview
    if (!q) {
      return res.json({
        mode: 'rules-overview',
        rules: data.designRules.map(r => ({
          name: r.name,
          site: r.site,
          refCount: r.refCount,
          ruleCount: r.tableRules.length,
          isP2: r.isP2 || false,
        })),
      });
    }

    const keywords = expandKeywords(q);

    // Check if query is a rule number (e.g. "8" or "編號8")
    const numMatch = q.match(/(\d+)/);

    const results = {
      query: q,
      mode: 'rules',
      matched: [],
    };

    for (const rule of data.designRules) {
      let matched = false;
      let matchedTableRules = [];

      // Match by name
      if (matchesAny(rule.name, keywords)) {
        matched = true;
        matchedTableRules = rule.tableRules;
      }

      // Match by number
      if (numMatch && rule.tableRules.some(tr => tr.id === numMatch[1])) {
        matched = true;
        matchedTableRules = rule.tableRules.filter(tr => tr.id === numMatch[1]);
      }

      // Match by content
      if (!matched && matchesAny(rule.body, keywords)) {
        matched = true;
        matchedTableRules = rule.tableRules.filter(tr =>
          matchesAny(tr.target, keywords) || matchesAny(tr.rule, keywords)
        );
      }

      if (matched) {
        results.matched.push({
          name: rule.name,
          site: rule.site,
          refCount: rule.refCount,
          isP2: rule.isP2 || false,
          matchedRules: matchedTableRules,
          allRules: rule.tableRules,
        });
      }
    }

    res.json(results);
  });

  // ============================================
  // AI-powered endpoints (search + summarize)
  // ============================================

  // Helper: run the search logic internally
  function runSearch(mode, q) {
    const keywords = expandKeywords(q);

    if (mode === 'logic') {
      const rules = [];
      for (const rule of data.designRules) {
        if (matchesAny(rule.name, keywords) || matchesAny(rule.body, keywords)) {
          rules.push({
            name: rule.name, site: rule.site, refCount: rule.refCount, isP2: rule.isP2 || false,
            tableRules: rule.tableRules.filter(tr => matchesAny(tr.target, keywords) || matchesAny(tr.rule, keywords) || matchesAny(tr.type, keywords)),
            allRules: rule.tableRules,
          });
        }
      }
      const rpHits = [];
      for (const page of data.rpPages) {
        const matched = page.texts.filter(t => matchesAny(t, keywords));
        if (matched.length > 0) {
          const specs = matched.filter(t => t.length > 30);
          if (specs.length > 0) rpHits.push({ site: page.site, page: page.page, matchCount: matched.length, specSamples: specs.slice(0, 3) });
        }
      }
      rpHits.sort((a, b) => b.matchCount - a.matchCount);
      const knowledgeBase = [];
      for (const entry of data.knowledgeBase) {
        if (matchesAny(entry.title, keywords) || matchesAny(entry.body, keywords)) {
          const bodyLines = entry.body.split('\n').filter(l => matchesAny(l, keywords));
          knowledgeBase.push({ module: entry.module, title: entry.title, matchedLines: bodyLines.slice(0, 5) });
        }
      }
      return { rules, specifications: rpHits.slice(0, 20), knowledgeBase };
    }

    if (mode === 'feature') {
      const knowledgeBase = [];
      for (const entry of data.knowledgeBase) {
        if (matchesAny(entry.title, keywords) || matchesAny(entry.body, keywords)) {
          knowledgeBase.push({ module: entry.module, title: entry.title, snippet: entry.body.substring(0, 200) });
        }
      }
      const rpPages = { byName: [], byContent: [] };
      for (const page of data.rpPages) {
        const nameMatch = matchesAny(page.page, keywords);
        const contentMatches = page.texts.filter(t => matchesAny(t, keywords));
        if (nameMatch) rpPages.byName.push({ site: page.site, page: page.page });
        else if (contentMatches.length > 0) rpPages.byContent.push({ site: page.site, page: page.page, matchCount: contentMatches.length, samples: contentMatches.slice(0, 2).map(t => t.substring(0, 100)) });
      }
      rpPages.byContent.sort((a, b) => b.matchCount - a.matchCount);
      rpPages.byContent = rpPages.byContent.slice(0, 30);
      const gorSet = new Set();
      [...rpPages.byName, ...rpPages.byContent].forEach(p => { const m = p.page.match(/gor-(\d+)/i); if (m) gorSet.add(`GOR-${m[1]}`); });
      return { knowledgeBase, rpPages, gorList: [...gorSet].sort() };
    }

    if (mode === 'impact') {
      let totalPages = 0;
      const bySite = {};
      for (const page of data.rpPages) {
        const matched = page.texts.filter(t => matchesAny(t, keywords));
        if (matched.length === 0 && !matchesAny(page.page, keywords)) continue;
        if (!bySite[page.site]) bySite[page.site] = { count: 0, pages: [] };
        bySite[page.site].count++;
        totalPages++;
        if (bySite[page.site].pages.length < 15) {
          bySite[page.site].pages.push({ page: page.page, matchCount: matched.length, isNameMatch: matchesAny(page.page, keywords) });
        }
      }
      const kbModules = new Set();
      for (const entry of data.knowledgeBase) {
        if (matchesAny(entry.title, keywords) || matchesAny(entry.body, keywords)) kbModules.add(entry.module);
      }
      return { totalPages, bySite, affectedModules: [...kbModules] };
    }

    if (mode === 'rules') {
      const numMatch = q.match(/(\d+)/);
      const matched = [];
      for (const rule of data.designRules) {
        let hit = false;
        let matchedRules = [];
        if (matchesAny(rule.name, keywords)) { hit = true; matchedRules = rule.tableRules; }
        if (numMatch && rule.tableRules.some(tr => tr.id === numMatch[1])) { hit = true; matchedRules = rule.tableRules.filter(tr => tr.id === numMatch[1]); }
        if (!hit && matchesAny(rule.body, keywords)) { hit = true; matchedRules = rule.tableRules.filter(tr => matchesAny(tr.target, keywords) || matchesAny(tr.rule, keywords)); }
        if (hit) matched.push({ name: rule.name, site: rule.site, refCount: rule.refCount, isP2: rule.isP2 || false, matchedRules, allRules: rule.tableRules });
      }
      return { matched };
    }

    return {};
  }

  router.get('/ai/:mode', async (req, res) => {
    const mode = req.params.mode;
    const q = req.query.q;
    if (!q) return res.json({ error: 'Missing query parameter q' });
    if (!['logic', 'feature', 'impact', 'rules'].includes(mode)) return res.json({ error: 'Invalid mode' });

    try {
      const searchResults = runSearch(mode, q);
      const aiResult = await summarizeQuery(q, searchResults, mode);

      // Post-validation
      const validation = validateAIOutput(aiResult.summary, searchResults, mode);

      // Build search meta
      const searchMeta = {
        logic: { rules: (searchResults.rules || []).length, specs: (searchResults.specifications || []).length, kb: (searchResults.knowledgeBase || []).length },
        feature: { kb: (searchResults.knowledgeBase || []).length, rpName: (searchResults.rpPages?.byName || []).length, rpContent: (searchResults.rpPages?.byContent || []).length, gor: (searchResults.gorList || []).length },
        impact: { totalPages: searchResults.totalPages || 0, sites: Object.keys(searchResults.bySite || {}).length, modules: (searchResults.affectedModules || []).length },
        rules: { matched: (searchResults.matched || []).length },
      }[mode] || {};

      // Build compact raw results for "view source" panel
      const rawPreview = buildRawPreview(searchResults, mode);

      res.json({
        query: q,
        mode,
        summary: aiResult.summary,
        usage: aiResult.usage,
        searchMeta,
        validation,
        rawPreview,
        totalRpPages: data.rpPages.length,
      });
    } catch (err) {
      console.error('AI endpoint error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  function buildRawPreview(results, mode) {
    const preview = [];
    if (mode === 'logic') {
      (results.rules || []).forEach(r => preview.push({ type: '通則', label: r.name, site: r.site }));
      (results.specifications || []).slice(0, 10).forEach(s => preview.push({ type: 'RP', label: s.page, site: s.site, matchCount: s.matchCount }));
      (results.knowledgeBase || []).forEach(e => preview.push({ type: '知識庫', label: `${e.module}/${e.title}` }));
    } else if (mode === 'feature') {
      (results.knowledgeBase || []).forEach(e => preview.push({ type: '知識庫', label: `${e.module}/${e.title}` }));
      (results.rpPages?.byName || []).forEach(p => preview.push({ type: 'RP檔名', label: p.page, site: p.site }));
      (results.rpPages?.byContent || []).slice(0, 10).forEach(p => preview.push({ type: 'RP內容', label: p.page, site: p.site, matchCount: p.matchCount }));
    } else if (mode === 'impact') {
      for (const [site, info] of Object.entries(results.bySite || {})) {
        info.pages.slice(0, 5).forEach(p => preview.push({ type: 'RP', label: p.page, site, matchCount: p.matchCount }));
      }
    } else if (mode === 'rules') {
      (results.matched || []).forEach(r => preview.push({ type: '通則', label: r.name, site: r.site, ruleCount: (r.matchedRules || r.allRules || []).length }));
    }
    return preview;
  }

  // ============================================
  // Stats endpoint
  // ============================================
  router.get('/stats', (req, res) => {
    const siteStats = {};
    for (const page of data.rpPages) {
      if (!siteStats[page.site]) siteStats[page.site] = { pages: 0, texts: 0 };
      siteStats[page.site].pages++;
      siteStats[page.site].texts += page.texts.length;
    }

    res.json({
      rpPages: data.rpPages.length,
      rpTextBlocks: data.rpPages.reduce((sum, p) => sum + p.texts.length, 0),
      knowledgeBaseEntries: data.knowledgeBase.length,
      designRules: data.designRules.length,
      siteStats,
    });
  });

  return router;
}

module.exports = { createSearchRouter };
