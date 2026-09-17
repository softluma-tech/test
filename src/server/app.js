
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import postbackRoutes from './routes/postback.js';
import miniAppRouter from './routes/miniApp.js';
import { getConfig } from '../services/adminService.js';
import { generateAffiliateLink } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: false }));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
});
app.use(authLimiter);

const postbackLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
});

const lidLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
});

const miniAppLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/postback', postbackLimiter, postbackRoutes);
app.use('/app', miniAppLimiter, miniAppRouter);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/lid', lidLimiter, async (req, res) => {
    try {
        const lid = await getConfig('affiliate_lid');
        if (!lid) {
            return res.status(404).send('Affiliate link not configured yet.');
        }
        const link = generateAffiliateLink(lid);
        res.redirect(link);
    } catch (err) {
        logger.error('Redirect Error:', err);
        res.status(500).send('Server Error');
    }
});

export default app;
