const express = require('express');
const path = require('path');
const { loadAllData } = require('./data-loader');
const { createSearchRouter } = require('./search');

const app = express();
const PORT = process.env.PORT || 3210;

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// Load data
console.log('Loading data...');
const data = loadAllData();
console.log(`Loaded: ${data.rpPages.length} RP pages, ${data.knowledgeBase.length} KB entries, ${data.designRules.length} rules`);

// API routes
app.use('/api', createSearchRouter(data));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`PM Dashboard running at http://localhost:${PORT}`);
});
