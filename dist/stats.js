import { getProvider, closeProvider } from './db.js';
import { SqliteProvider } from './providers/sqlite-provider.js';
import fs from 'fs';
export async function getIndexStats(dbPath) {
    try {
        let provider;
        let shouldClose = true;
        if (dbPath) {
            // Direct SQLite path provided - create a temporary provider
            provider = new SqliteProvider({ path: dbPath });
            await provider.initialize();
        }
        else {
            // Use the configured provider
            provider = await getProvider();
            shouldClose = true;
        }
        const stats = await provider.getStats();
        // Check for summaries (these are files, not DB fields)
        let withSummariesCount = 0;
        for (const archivePath of stats.archivePaths) {
            const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
            if (fs.existsSync(summaryPath)) {
                withSummariesCount++;
            }
        }
        if (dbPath) {
            await provider.close();
        }
        else {
            await closeProvider();
        }
        return {
            totalConversations: stats.totalConversations,
            conversationsWithSummaries: withSummariesCount,
            conversationsWithoutSummaries: stats.totalConversations - withSummariesCount,
            totalExchanges: stats.totalExchanges,
            dateRange: stats.dateRange,
            projectCount: stats.projectCount,
            topProjects: stats.topProjects,
            databaseProvider: provider.name,
        };
    }
    catch (error) {
        // Database might not exist yet
        return {
            totalConversations: 0,
            conversationsWithSummaries: 0,
            conversationsWithoutSummaries: 0,
            totalExchanges: 0,
            projectCount: 0,
        };
    }
}
export function formatStats(stats) {
    let output = 'Episodic Memory Index Statistics\n';
    output += '='.repeat(50) + '\n\n';
    if (stats.databaseProvider) {
        output += `Database Provider: ${stats.databaseProvider}\n\n`;
    }
    output += `Total Conversations: ${stats.totalConversations.toLocaleString()}\n`;
    output += `Total Exchanges: ${stats.totalExchanges.toLocaleString()}\n\n`;
    output += `With Summaries: ${stats.conversationsWithSummaries.toLocaleString()}\n`;
    output += `Without Summaries: ${stats.conversationsWithoutSummaries.toLocaleString()}\n`;
    if (stats.conversationsWithoutSummaries > 0 && stats.totalConversations > 0) {
        const percentage = ((stats.conversationsWithoutSummaries / stats.totalConversations) * 100).toFixed(1);
        output += `  (${percentage}% missing summaries)\n`;
    }
    output += '\n';
    if (stats.dateRange) {
        output += `Date Range:\n`;
        output += `  Earliest: ${new Date(stats.dateRange.earliest).toLocaleDateString()}\n`;
        output += `  Latest: ${new Date(stats.dateRange.latest).toLocaleDateString()}\n\n`;
    }
    output += `Unique Projects: ${stats.projectCount.toLocaleString()}\n\n`;
    if (stats.topProjects && stats.topProjects.length > 0) {
        output += `Top Projects by Conversation Count:\n`;
        for (const { project, count } of stats.topProjects) {
            const displayProject = project || '(unknown)';
            output += `  ${count.toString().padStart(4)} - ${displayProject}\n`;
        }
    }
    return output;
}
