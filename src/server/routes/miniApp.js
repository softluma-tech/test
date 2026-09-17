import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateInitData } from '../../utils/initData.js';
import { config } from '../../config.js';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/miniapp/index.html'));
});

router.post('/api/validate', async (req, res) => {
  try {
    const { initData } = req.body || {};
    const user = validateInitData(initData, config.botToken);
    if (!user) {
      return res.status(401).json({ valid: false });
    }
    res.json({ valid: true, user });
  } catch (err) {
    logger.error('MiniApp validate error:', err);
    res.status(500).json({ valid: false, error: 'server_error' });
  }
});

export default router;