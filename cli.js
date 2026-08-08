const db = require('./db');
const scraper = require('./scraper');

const MAX_EXECUTION_TIME_MS = 5.5 * 60 * 60 * 1000; // 5.5 hours

async function run() {
    console.log("Initializing Master DB...");
    await db.initMasterDB();
    
    // Command line arguments for Map-Reduce Tracks
    const args = process.argv.slice(2);
    const command = args[0] || 'legacy';
    
    // Set up graceful shutdown timer
    setTimeout(async () => {
        console.log("⏰ TIME LIMIT REACHED! Gracefully shutting down scraper.");
        await db.closeAll();
        process.exit(0);
    }, MAX_EXECUTION_TIME_MS);
    
    if (command === 'track-a') {
        console.log("--- Starting Track A (Coordinator) ---");
        await scraper.runTrackA();
    } else if (command === 'track-b-genres') {
        const totalShards = parseInt(args[1], 10);
        const shardIndex = parseInt(args[2], 10);
        console.log(`--- Starting Track B (Genre Swarm) Shard ${shardIndex}/${totalShards} ---`);
        await scraper.runTrackBGenres(totalShards, shardIndex);
    } else if (command === 'track-b-discovery') {
        const totalShards = parseInt(args[1], 10);
        const shardIndex = parseInt(args[2], 10);
        console.log(`--- Starting Track B (Discovery Swarm) Shard ${shardIndex}/${totalShards} ---`);
        await scraper.runTrackBDiscovery(totalShards, shardIndex);
    } else if (command === 'track-b-all') {
        const totalShards = parseInt(args[1], 10);
        const shardIndex = parseInt(args[2], 10);
        console.log(`--- Starting Track B (Combined Swarm) Shard ${shardIndex}/${totalShards} ---`);
        await scraper.runTrackBAll(totalShards, shardIndex);
    } else if (command === 'track-c') {
        console.log("--- Starting Track C (Aggregator) ---");
        await scraper.runTrackCAggregator();
    } else if (command === 'webhook') {
        const url = process.env.DISCORD_WEBHOOK_URL;
        if (!url) {
            console.log("No DISCORD_WEBHOOK_URL found. Skipping.");
        } else {
            console.log("Sending Discord Webhook...");
            const allMaps = await db.getAllMaps();
            const dateStr = new Date().toISOString().split('T')[0];
            const payload = {
                content: `🚀 **Ecosystem Scrape Complete!**\n- **Date:** ${dateStr}\n- **Total Maps in DB:** ${allMaps.length}\n- Databases successfully compressed & uploaded to GitHub Releases!`,
                username: "Fortnite Analytics",
                avatar_url: "https://fortniteapi.io/images/logo.png"
            };
            try {
                const axios = require('axios');
                await axios.post(url, payload);
                console.log("Webhook sent successfully!");
            } catch (e) {
                console.error("Failed to send webhook:", e.message);
            }
        }
    } else {
        console.log("--- Starting Legacy CLI Scraper Run ---");
        await scraper.runFullPipeline();
    }
    
    console.log("CLI Scraper Run Completed.");
    await db.closeAll();
    process.exit(0);
}

run().catch(async (e) => {
    console.error("CLI Scraper Fatal Error:", e);
    await db.closeAll();
    process.exit(1);
});
