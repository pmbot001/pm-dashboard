const express = require('express');
const path = require('path');
const { createMinaMentionsRouter } = require('./mina-mentions');

const app = express();
const PORT = process.env.PORT || 3210;

app.use(express.static(path.join(__dirname, '../public')));

app.use('/api', createMinaMentionsRouter());

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`PM Dashboard running at http://localhost:${PORT}`);
});
