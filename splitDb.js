const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_DIR = path.join(__dirname, 'db');
const MASTER_DB = path.join(DB_DIR, 'maps.db');

const ACTIVE_MAPS_DB = path.join(DB_DIR, 'ActiveMaps.db');
const ARCHIVED_MAPS_DB = path.join(DB_DIR, 'ArchivedMaps.db');
const ECOSYSTEM_MASTER_DB = path.join(DB_DIR, 'EcosystemMaster.db');

async function copyFile(src, dest) {
    return new Promise((resolve, reject) => {
        fs.copyFile(src, dest, err => err ? reject(err) : resolve());
    });
}

async function runQuery(dbPath, sql) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
        });
        db.exec(sql, (err) => {
            db.close();
            if (err) return reject(err);
            resolve();
        });
    });
}

async function splitDatabases() {
    console.log("=== STARTING DATABASE SPLIT ===");
    
    if (!fs.existsSync(MASTER_DB)) {
        console.error("Master maps.db not found. Skipping split.");
        return;
    }

    try {
        // 1. Create EcosystemMaster.db (direct copy)
        console.log("Creating EcosystemMaster.db (Full Copy)...");
        await copyFile(MASTER_DB, ECOSYSTEM_MASTER_DB);

        // 2. Create ActiveMaps.db
        console.log("Creating ActiveMaps.db (CCU > 0 or Plays > 0)...");
        await copyFile(MASTER_DB, ACTIVE_MAPS_DB);
        await runQuery(ACTIVE_MAPS_DB, `
            DELETE FROM maps WHERE latest_peak_ccu = 0 AND latest_plays = 0;
            VACUUM;
        `);

        // 3. Create ArchivedMaps.db
        console.log("Creating ArchivedMaps.db (CCU = 0 and Plays = 0)...");
        await copyFile(MASTER_DB, ARCHIVED_MAPS_DB);
        await runQuery(ARCHIVED_MAPS_DB, `
            DELETE FROM maps WHERE latest_peak_ccu > 0 OR latest_plays > 0;
            VACUUM;
        `);
        
        console.log("=== DATABASE SPLIT COMPLETE ===");
        
    } catch (e) {
        console.error("Error splitting databases:", e);
    }
}

splitDatabases();
