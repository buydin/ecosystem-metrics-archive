const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const scraper = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize DB on startup
db.initMasterDB().then(() => console.log('Master DB initialized.')).catch(console.error);

// --- API Endpoints ---

// Get all maps with optional filtering and sorting
app.get('/api/maps', async (req, res) => {
    try {
        let maps = await db.getAllMaps();
        
        const { category, tag, sort } = req.query;
        
        if (category) {
            maps = maps.filter(m => m.category && m.category.toLowerCase() === category.toLowerCase());
        }
        
        if (tag) {
            maps = maps.filter(m => {
                if (!m.tags) return false;
                try {
                    const parsedTags = JSON.parse(m.tags);
                    return parsedTags.some(t => t.toLowerCase() === tag.toLowerCase());
                } catch(e) { return false; }
            });
        }
        
        // Sorting (default is already by latest_peak_ccu DESC from db.js)
        if (sort === 'title') {
            maps.sort((a, b) => a.title.localeCompare(b.title));
        } else if (sort === 'added') {
            maps.sort((a, b) => new Date(b.added_at) - new Date(a.added_at));
        }

        // Pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100;
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;

        const results = maps.slice(startIndex, endIndex);

        res.json({
            total: maps.length,
            page,
            limit,
            totalPages: Math.ceil(maps.length / limit),
            data: results
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get historical metrics for a specific map
app.get('/api/maps/:code/history', async (req, res) => {
    try {
        const { code } = req.params;
        const interval = req.query.interval || 'hour'; // minute, hour, day
        const table = `metrics_${interval}`;
        const limitDays = parseInt(req.query.days) || 7;
        
        const history = await db.getHistoryForMap(code, table, limitDays);
        res.json({ data: history });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Trigger a manual scrape (Admin only ideally)
app.post('/api/scrape/discovery', async (req, res) => {
    // Run async in background
    scraper.runDiscoveryPhase().catch(console.error);
    res.json({ message: "Discovery phase started in background." });
});

app.post('/api/scrape/metrics', async (req, res) => {
    // Run async in background
    scraper.runMetricsPhase().catch(console.error);
    res.json({ message: "Metrics phase started in background." });
});

// Export a daily DB file
app.get('/api/export/:date', (req, res) => {
    const { date } = req.params;
    const dbPath = path.join(__dirname, 'db', `metrics_${date}.db`);
    
    if (require('fs').existsSync(dbPath)) {
        res.download(dbPath);
    } else {
        res.status(404).json({ error: "Database for that date not found." });
    }
});

// --- CRON JOBS ---
// Run discovery every 12 hours
cron.schedule('0 */12 * * *', () => {
    console.log("Running scheduled Discovery Phase...");
    scraper.runDiscoveryPhase().catch(console.error);
});

// Run metrics update every 6 hours
cron.schedule('0 */6 * * *', () => {
    console.log("Running scheduled Metrics Phase...");
    scraper.runMetricsPhase().catch(console.error);
});

app.listen(PORT, () => {
    console.log(`Fortnite Scraper Analytics Server running on http://localhost:${PORT}`);
});
