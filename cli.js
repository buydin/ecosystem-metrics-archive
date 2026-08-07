const db = require('./db');
const scraper = require('./scraper');

const MAX_EXECUTION_TIME_MS = 5.5 * 60 * 60 * 1000; // 5.5 hours to give GitHub Actions 30 mins to upload releases

async function run() {
    console.log("Initializing Master DB...");
    await db.initMasterDB();
    
    // We set a global timeout. The easiest way without restructuring the entire scraper loop 
    // is to just run it and let the GitHub Actions 6-hour limit kill it naturally if we are using UPSERT.
    // However, since we want a graceful shutdown, we'll track time inside scraper.js if we wanted to.
    // For simplicity, we just run both phases sequentially. 
    // Because SQLite is transactional per query, it's safe if it gets killed!
    
    console.log("Starting CLI Scraper Run...");
    
    // Set up graceful shutdown timer
    setTimeout(async () => {
        console.log("⏰ TIME LIMIT REACHED! Gracefully shutting down scraper so GitHub Actions can upload the databases!");
        await db.closeAll();
        process.exit(0);
    }, MAX_EXECUTION_TIME_MS);
    
    // Execute the ultra-optimized 4-step scraping pipeline
    await scraper.runFullPipeline();
    
    console.log("CLI Scraper Run Completed.");
    await db.closeAll();
    process.exit(0);
}

run().catch(async (e) => {
    console.error("CLI Scraper Fatal Error:", e);
    await db.closeAll();
    process.exit(1);
});
