const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR);
}

// Master Database Connection
const masterDb = new sqlite3.Database(path.join(DB_DIR, 'maps.db'));
masterDb.run('PRAGMA journal_mode = WAL;');
masterDb.run('PRAGMA busy_timeout = 5000;');

// Promisify database methods for cleaner async/await usage
function runQuery(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getQuery(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function allQuery(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// Initialize Master Database
async function initMasterDB() {
    await runQuery(masterDb, `
        CREATE TABLE IF NOT EXISTS maps (
            code TEXT PRIMARY KEY,
            title TEXT,
            creatorCode TEXT,
            category TEXT,
            tags TEXT,
            createdIn TEXT,
            latest_peak_ccu INTEGER DEFAULT 0,
            latest_favorites INTEGER DEFAULT 0,
            latest_plays INTEGER DEFAULT 0,
            latest_unique_players INTEGER DEFAULT 0,
            latest_avg_minutes REAL DEFAULT 0,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Attempt to add columns if they don't exist (for existing DB migration)
    try { await runQuery(masterDb, `ALTER TABLE maps ADD COLUMN latest_favorites INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(masterDb, `ALTER TABLE maps ADD COLUMN latest_plays INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(masterDb, `ALTER TABLE maps ADD COLUMN latest_unique_players INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(masterDb, `ALTER TABLE maps ADD COLUMN latest_avg_minutes REAL DEFAULT 0`); } catch (e) {}
}

// Map Metadata Functions
async function upsertMap(mapData) {
    const { code, title, creatorCode, category, tags, createdIn } = mapData;
    const tagsStr = Array.isArray(tags) ? JSON.stringify(tags) : tags;
    
    await runQuery(masterDb, `
        INSERT INTO maps (code, title, creatorCode, category, tags, createdIn)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET 
            title = excluded.title,
            creatorCode = excluded.creatorCode,
            category = excluded.category,
            tags = excluded.tags,
            createdIn = excluded.createdIn
    `, [code, title, creatorCode, category, tagsStr, createdIn]);
}

async function getAllMaps() {
    return await allQuery(masterDb, `SELECT * FROM maps ORDER BY latest_peak_ccu DESC`);
}

async function updateMapLatestMetrics(code, metrics) {
    await runQuery(masterDb, `
        UPDATE maps 
        SET latest_peak_ccu = ?,
            latest_favorites = ?,
            latest_plays = ?,
            latest_unique_players = ?,
            latest_avg_minutes = ?
        WHERE code = ?
    `, [
        metrics.latestCCU || 0,
        metrics.latestFavorites || 0,
        metrics.latestPlays || 0,
        metrics.latestUniquePlayers || 0,
        metrics.latestAvgMinutes || 0,
        code
    ]);
}

// --- Daily Sharding Functions --- //

// Cache for open daily DB connections
const dailyDbs = {};

function getDailyDb(dateString) { // e.g., '2026-08-07'
    if (dailyDbs[dateString]) {
        return dailyDbs[dateString];
    }
    
    const dbPath = path.join(DB_DIR, `metrics_${dateString}.db`);
    const db = new sqlite3.Database(dbPath);
    
    // Configure robust concurrency
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA busy_timeout = 5000;');
    
    // Initialize tables if they don't exist
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS metrics_minute (
                map_code TEXT,
                timestamp TEXT,
                peak_ccu INTEGER,
                favorites INTEGER,
                minutes_played INTEGER,
                recommendations INTEGER,
                plays INTEGER,
                unique_players INTEGER,
                UNIQUE(map_code, timestamp)
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS metrics_hour (
                map_code TEXT,
                timestamp TEXT,
                peak_ccu INTEGER,
                favorites INTEGER,
                minutes_played INTEGER,
                average_minutes_per_player REAL,
                recommendations INTEGER,
                plays INTEGER,
                unique_players INTEGER,
                rankings TEXT,
                UNIQUE(map_code, timestamp)
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS metrics_day (
                map_code TEXT,
                timestamp TEXT,
                peak_ccu INTEGER,
                favorites INTEGER,
                minutes_played INTEGER,
                average_minutes_per_player REAL,
                recommendations INTEGER,
                plays INTEGER,
                unique_players INTEGER,
                retention_d1 REAL,
                retention_d7 REAL,
                rankings TEXT,
                UNIQUE(map_code, timestamp)
            )
        `);
    });
    
    dailyDbs[dateString] = db;
    return db;
}

// Extracts 'YYYY-MM-DD' from an ISO timestamp '2026-08-07T08:30:00.000Z'
function extractDateFromTimestamp(timestamp) {
    return timestamp.split('T')[0];
}

// Insert interval record
// 'table' must be 'metrics_minute', 'metrics_hour', or 'metrics_day'
async function upsertMetricRecord(table, code, timestamp, data) {
    const dateStr = extractDateFromTimestamp(timestamp);
    const db = getDailyDb(dateStr);
    
    if (table === 'metrics_minute') {
        await runQuery(db, `
            INSERT INTO metrics_minute (map_code, timestamp, peak_ccu, favorites, minutes_played, recommendations, plays, unique_players)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(map_code, timestamp) DO UPDATE SET
                peak_ccu = COALESCE(excluded.peak_ccu, peak_ccu),
                favorites = COALESCE(excluded.favorites, favorites),
                minutes_played = COALESCE(excluded.minutes_played, minutes_played),
                recommendations = COALESCE(excluded.recommendations, recommendations),
                plays = COALESCE(excluded.plays, plays),
                unique_players = COALESCE(excluded.unique_players, unique_players)
        `, [
            code, timestamp, 
            data.peakCCU, data.favorites, data.minutesPlayed, 
            data.recommendations, data.plays, data.uniquePlayers
        ]);
    } else if (table === 'metrics_hour') {
        await runQuery(db, `
            INSERT INTO metrics_hour (map_code, timestamp, peak_ccu, favorites, minutes_played, average_minutes_per_player, recommendations, plays, unique_players, rankings)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(map_code, timestamp) DO UPDATE SET
                peak_ccu = COALESCE(excluded.peak_ccu, peak_ccu),
                favorites = COALESCE(excluded.favorites, favorites),
                minutes_played = COALESCE(excluded.minutes_played, minutes_played),
                average_minutes_per_player = COALESCE(excluded.average_minutes_per_player, average_minutes_per_player),
                recommendations = COALESCE(excluded.recommendations, recommendations),
                plays = COALESCE(excluded.plays, plays),
                unique_players = COALESCE(excluded.unique_players, unique_players),
                rankings = COALESCE(excluded.rankings, rankings)
        `, [
            code, timestamp, 
            data.peakCCU, data.favorites, data.minutesPlayed, data.averageMinutesPerPlayer,
            data.recommendations, data.plays, data.uniquePlayers, data.rankings ? JSON.stringify(data.rankings) : null
        ]);
    } else if (table === 'metrics_day') {
        await runQuery(db, `
            INSERT INTO metrics_day (map_code, timestamp, peak_ccu, favorites, minutes_played, average_minutes_per_player, recommendations, plays, unique_players, retention_d1, retention_d7, rankings)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(map_code, timestamp) DO UPDATE SET
                peak_ccu = COALESCE(excluded.peak_ccu, peak_ccu),
                favorites = COALESCE(excluded.favorites, favorites),
                minutes_played = COALESCE(excluded.minutes_played, minutes_played),
                average_minutes_per_player = COALESCE(excluded.average_minutes_per_player, average_minutes_per_player),
                recommendations = COALESCE(excluded.recommendations, recommendations),
                plays = COALESCE(excluded.plays, plays),
                unique_players = COALESCE(excluded.unique_players, unique_players),
                retention_d1 = COALESCE(excluded.retention_d1, retention_d1),
                retention_d7 = COALESCE(excluded.retention_d7, retention_d7),
                rankings = COALESCE(excluded.rankings, rankings)
        `, [
            code, timestamp, 
            data.peakCCU, data.favorites, data.minutesPlayed, data.averageMinutesPerPlayer,
            data.recommendations, data.plays, data.uniquePlayers, 
            data.retention_d1, data.retention_d7,
            data.rankings ? JSON.stringify(data.rankings) : null
        ]);
    }
}

// Fetch historical records for a map across multiple databases
// By default, it will fetch from the latest available daily DBs
async function getHistoryForMap(code, table, limitDays = 7) {
    // Get all daily DB files
    const files = fs.readdirSync(DB_DIR).filter(f => f.startsWith('metrics_') && f.endsWith('.db'));
    // Sort descending (newest first)
    files.sort((a, b) => b.localeCompare(a));
    
    // Take the newest 'limitDays' databases
    const dbFilesToQuery = files.slice(0, limitDays);
    
    let allRecords = [];
    
    for (const file of dbFilesToQuery) {
        const dateStr = file.replace('metrics_', '').replace('.db', '');
        const db = getDailyDb(dateStr);
        
        try {
            const records = await allQuery(db, `SELECT * FROM ${table} WHERE map_code = ? ORDER BY timestamp ASC`, [code]);
            allRecords = [...records, ...allRecords]; // Prepend since we are going backward in time, we want final array chronological
        } catch(e) {
            console.error(`Error querying ${file}:`, e.message);
        }
    }
    
    return allRecords;
}

async function closeAll() {
    console.log("Closing databases and checkpointing WAL...");
    const closePromises = [];
    
    // Close daily DBs
    for (const key in dailyDbs) {
        closePromises.push(new Promise((resolve) => {
            dailyDbs[key].close(() => resolve());
        }));
    }
    
    // Close master DB
    closePromises.push(new Promise((resolve) => {
        masterDb.close(() => resolve());
    }));
    
    await Promise.all(closePromises);
    console.log("Databases securely closed.");
}

async function getMapsProcessedToday(dateString) {
    const db = getDailyDb(dateString);
    try {
        const records = await allQuery(db, `SELECT DISTINCT map_code FROM metrics_day`);
        return records.map(r => r.map_code);
    } catch (e) {
        return [];
    }
}

module.exports = {
    initMasterDB,
    upsertMap,
    getAllMaps,
    updateMapLatestMetrics,
    upsertMetricRecord,
    getHistoryForMap,
    getMapsProcessedToday,
    closeAll
};
