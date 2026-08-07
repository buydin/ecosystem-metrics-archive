const db = require('./db');
const scraper = require('./scraper');

const MAX_EXECUTION_TIME_MS = 5.5 * 60 * 60 * 1000; // 5.5 hours

async function run() {
    console.log("Initializing Master DB...");
    await db.initMasterDB();
    
    // We set a global timeout. The easiest way without restructuring the entire scraper loop 
    // is to just run it and let the GitHub Actions 6-hour limit kill it naturally if we are using UPSERT.
    // However, since we want a graceful shutdown, we'll track time inside scraper.js if we wanted to.
    // For simplicity, we just run both phases sequentially. 
    // Because SQLite is transactional per query, it's safe if it gets killed!
    
    console.log("Starting CLI Scraper Run...");
    
    // Set up graceful shutdown timer (5.5 hours)
    setTimeout(() => {
        console.log("⏰ 5.5 HOUR TIME LIMIT REACHED! Gracefully shutting down scraper so GitHub Actions can upload the databases!");
        process.exit(0);
    }, MAX_EXECUTION_TIME_MS);
    
    // 1. Discover new maps
    await scraper.runDiscoveryPhase();
    
    // 2. Fetch metrics
    await scraper.runMetricsPhase();
    
    console.log("CLI Scraper Run Completed.");
    process.exit(0);
}

run().catch(e => {
    console.error("CLI Scraper Fatal Error:", e);
    process.exit(1);
});
