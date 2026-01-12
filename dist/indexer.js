import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProvider, closeProvider } from './db.js';
import { parseConversation } from './parser.js';
import { initEmbeddings, generateExchangeEmbedding } from './embeddings.js';
import { summarizeConversation } from './summarizer.js';
import { getArchiveDir, getExcludedProjects } from './paths.js';
import { isPostgresql } from './config.js';
// Helper to extract session ID from file path
function extractSessionIdFromPath(filePath) {
    const basename = path.basename(filePath, '.jsonl');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(basename)) {
        return basename;
    }
    return null;
}
// Set max output tokens for Claude SDK (used by summarizer)
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000';
// Increase max listeners for concurrent API calls
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;
// Allow overriding paths for testing
function getProjectsDir() {
    return process.env.TEST_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}
// Process items in batches with limited concurrency
async function processBatch(items, processor, concurrency) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);
    }
    return results;
}
// Helper to check if a file is within the days limit based on mtime
function isWithinDaysLimit(filePath, days) {
    if (days === undefined)
        return true;
    const stat = fs.statSync(filePath);
    const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
    return stat.mtimeMs >= cutoffTime;
}
export async function indexConversations(limitToProject, maxConversations, concurrency = 1, noSummaries = false, days) {
    console.log('Initializing database...');
    const provider = await getProvider();
    console.log('Loading embedding model...');
    await initEmbeddings();
    if (noSummaries) {
        console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
    }
    if (days !== undefined) {
        console.log(`📅 Filtering to conversations from the last ${days} day(s)`);
    }
    if (maxConversations !== undefined) {
        console.log(`🔢 Limiting to ${maxConversations} conversation(s)`);
    }
    console.log('Scanning for conversation files...');
    const PROJECTS_DIR = getProjectsDir();
    const ARCHIVE_DIR = getArchiveDir();
    const projects = fs.readdirSync(PROJECTS_DIR);
    let totalExchanges = 0;
    let conversationsProcessed = 0;
    const excludedProjects = getExcludedProjects();
    for (const project of projects) {
        // Skip excluded projects
        if (excludedProjects.includes(project)) {
            console.log(`\nSkipping excluded project: ${project}`);
            continue;
        }
        // Skip if limiting to specific project
        if (limitToProject && project !== limitToProject)
            continue;
        const projectPath = path.join(PROJECTS_DIR, project);
        const stat = fs.statSync(projectPath);
        if (!stat.isDirectory())
            continue;
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        if (files.length === 0)
            continue;
        console.log(`\nProcessing project: ${project} (${files.length} conversations)`);
        if (concurrency > 1)
            console.log(`  Concurrency: ${concurrency}`);
        // Create archive directory for this project
        const projectArchive = path.join(ARCHIVE_DIR, project);
        fs.mkdirSync(projectArchive, { recursive: true });
        const toProcess = [];
        for (const file of files) {
            const sourcePath = path.join(projectPath, file);
            const archivePath = path.join(projectArchive, file);
            // Filter by days if specified
            if (!isWithinDaysLimit(sourcePath, days)) {
                continue;
            }
            // Copy to archive
            if (!fs.existsSync(archivePath)) {
                fs.copyFileSync(sourcePath, archivePath);
                console.log(`  Archived: ${file}`);
            }
            // Parse conversation
            const exchanges = await parseConversation(sourcePath, project, archivePath);
            if (exchanges.length === 0) {
                console.log(`  Skipped ${file} (no exchanges)`);
                continue;
            }
            toProcess.push({
                file,
                sourcePath,
                archivePath,
                summaryPath: archivePath.replace('.jsonl', '-summary.txt'),
                exchanges
            });
            // Check if we've collected enough conversations for this batch
            if (maxConversations && (conversationsProcessed + toProcess.length) >= maxConversations) {
                // Trim to exact limit needed
                const remaining = maxConversations - conversationsProcessed;
                if (toProcess.length > remaining) {
                    toProcess.length = remaining;
                }
                break;
            }
        }
        // Batch summarize conversations in parallel (unless --no-summaries)
        if (!noSummaries) {
            // Filter conversations that need summaries
            const usePostgres = isPostgresql();
            const needsSummary = [];
            for (const conv of toProcess) {
                const sessionId = extractSessionIdFromPath(conv.sourcePath);
                if (usePostgres && sessionId && provider.hasSummary) {
                    // Check DB for existing summary
                    const hasSummary = await provider.hasSummary(sessionId);
                    if (!hasSummary) {
                        needsSummary.push(conv);
                    }
                }
                else {
                    // Check local file for existing summary
                    if (!fs.existsSync(conv.summaryPath)) {
                        needsSummary.push(conv);
                    }
                }
            }
            if (needsSummary.length > 0) {
                console.log(`  Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...`);
                await processBatch(needsSummary, async (conv) => {
                    try {
                        const summary = await summarizeConversation(conv.exchanges);
                        // Write to DB if PostgreSQL, otherwise write to file
                        if (usePostgres && provider.setSummary) {
                            const sessionId = extractSessionIdFromPath(conv.sourcePath);
                            if (sessionId) {
                                await provider.setSummary(sessionId, project, summary);
                            }
                        }
                        else {
                            fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
                        }
                        const wordCount = summary.split(/\s+/).length;
                        console.log(`  ✓ ${conv.file}: ${wordCount} words`);
                        return summary;
                    }
                    catch (error) {
                        console.log(`  ✗ ${conv.file}: ${error}`);
                        return null;
                    }
                }, concurrency);
            }
        }
        else {
            console.log(`  Skipping ${toProcess.length} summaries (--no-summaries mode)`);
        }
        // Now process embeddings and DB inserts (fast, sequential is fine)
        for (const conv of toProcess) {
            for (const exchange of conv.exchanges) {
                const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                await provider.insertExchange(exchange, embedding, toolNames);
            }
            totalExchanges += conv.exchanges.length;
            conversationsProcessed++;
            // Check if we hit the limit
            if (maxConversations && conversationsProcessed >= maxConversations) {
                console.log(`\nReached limit of ${maxConversations} conversations`);
                await closeProvider();
                console.log(`✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
                return;
            }
        }
    }
    await closeProvider();
    console.log(`\n✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
}
export async function indexSession(sessionId, concurrency = 1, noSummaries = false) {
    console.log(`Indexing session: ${sessionId}`);
    // Find the conversation file for this session
    const PROJECTS_DIR = getProjectsDir();
    const ARCHIVE_DIR = getArchiveDir();
    const projects = fs.readdirSync(PROJECTS_DIR);
    const excludedProjects = getExcludedProjects();
    let found = false;
    for (const project of projects) {
        if (excludedProjects.includes(project))
            continue;
        const projectPath = path.join(PROJECTS_DIR, project);
        if (!fs.statSync(projectPath).isDirectory())
            continue;
        const files = fs.readdirSync(projectPath).filter(f => f.includes(sessionId) && f.endsWith('.jsonl'));
        if (files.length > 0) {
            found = true;
            const file = files[0];
            const sourcePath = path.join(projectPath, file);
            const provider = await getProvider();
            await initEmbeddings();
            const projectArchive = path.join(ARCHIVE_DIR, project);
            fs.mkdirSync(projectArchive, { recursive: true });
            const archivePath = path.join(projectArchive, file);
            // Archive
            if (!fs.existsSync(archivePath)) {
                fs.copyFileSync(sourcePath, archivePath);
            }
            // Parse and summarize
            const exchanges = await parseConversation(sourcePath, project, archivePath);
            if (exchanges.length > 0) {
                // Generate summary (unless --no-summaries)
                const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
                const usePostgres = isPostgresql();
                // Check if summary exists
                let needsSummary = false;
                if (!noSummaries) {
                    if (usePostgres && provider.hasSummary) {
                        needsSummary = !(await provider.hasSummary(sessionId));
                    }
                    else {
                        needsSummary = !fs.existsSync(summaryPath);
                    }
                }
                if (needsSummary) {
                    const summary = await summarizeConversation(exchanges);
                    // Write to DB if PostgreSQL, otherwise write to file
                    if (usePostgres && provider.setSummary) {
                        await provider.setSummary(sessionId, project, summary);
                    }
                    else {
                        fs.writeFileSync(summaryPath, summary, 'utf-8');
                    }
                    console.log(`Summary: ${summary.split(/\s+/).length} words`);
                }
                // Index
                for (const exchange of exchanges) {
                    const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                    const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                    await provider.insertExchange(exchange, embedding, toolNames);
                }
                console.log(`✅ Indexed session ${sessionId}: ${exchanges.length} exchanges`);
            }
            await closeProvider();
            break;
        }
    }
    if (!found) {
        console.log(`Session ${sessionId} not found`);
    }
}
export async function indexUnprocessed(concurrency = 1, noSummaries = false, days) {
    console.log('Finding unprocessed conversations...');
    if (concurrency > 1)
        console.log(`Concurrency: ${concurrency}`);
    if (noSummaries)
        console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
    if (days !== undefined)
        console.log(`📅 Filtering to conversations from the last ${days} day(s)`);
    const provider = await getProvider();
    await initEmbeddings();
    const PROJECTS_DIR = getProjectsDir();
    const ARCHIVE_DIR = getArchiveDir();
    const projects = fs.readdirSync(PROJECTS_DIR);
    const excludedProjects = getExcludedProjects();
    const unprocessed = [];
    // Collect all unprocessed conversations
    for (const project of projects) {
        if (excludedProjects.includes(project))
            continue;
        const projectPath = path.join(PROJECTS_DIR, project);
        if (!fs.statSync(projectPath).isDirectory())
            continue;
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
            const sourcePath = path.join(projectPath, file);
            const projectArchive = path.join(ARCHIVE_DIR, project);
            const archivePath = path.join(projectArchive, file);
            const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
            // Filter by days if specified
            if (!isWithinDaysLimit(sourcePath, days)) {
                continue;
            }
            // Check if already indexed in database
            const alreadyIndexed = await provider.hasExchangesForArchive(archivePath);
            if (alreadyIndexed)
                continue;
            fs.mkdirSync(projectArchive, { recursive: true });
            // Archive if needed
            if (!fs.existsSync(archivePath)) {
                fs.copyFileSync(sourcePath, archivePath);
            }
            // Parse and check
            const exchanges = await parseConversation(sourcePath, project, archivePath);
            if (exchanges.length === 0)
                continue;
            unprocessed.push({ project, file, sourcePath, archivePath, summaryPath, exchanges });
        }
    }
    if (unprocessed.length === 0) {
        console.log('✅ All conversations are already processed!');
        await closeProvider();
        return;
    }
    console.log(`Found ${unprocessed.length} unprocessed conversations`);
    // Batch process summaries (unless --no-summaries)
    if (!noSummaries) {
        const usePostgres = isPostgresql();
        const needsSummary = [];
        for (const conv of unprocessed) {
            const sessionId = extractSessionIdFromPath(conv.sourcePath);
            if (usePostgres && sessionId && provider.hasSummary) {
                const hasSummary = await provider.hasSummary(sessionId);
                if (!hasSummary) {
                    needsSummary.push(conv);
                }
            }
            else {
                if (!fs.existsSync(conv.summaryPath)) {
                    needsSummary.push(conv);
                }
            }
        }
        if (needsSummary.length > 0) {
            console.log(`Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...\n`);
            await processBatch(needsSummary, async (conv) => {
                try {
                    const summary = await summarizeConversation(conv.exchanges);
                    // Write to DB if PostgreSQL, otherwise write to file
                    if (usePostgres && provider.setSummary) {
                        const sessionId = extractSessionIdFromPath(conv.sourcePath);
                        if (sessionId) {
                            await provider.setSummary(sessionId, conv.project, summary);
                        }
                    }
                    else {
                        fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
                    }
                    const wordCount = summary.split(/\s+/).length;
                    console.log(`  ✓ ${conv.project}/${conv.file}: ${wordCount} words`);
                    return summary;
                }
                catch (error) {
                    console.log(`  ✗ ${conv.project}/${conv.file}: ${error}`);
                    return null;
                }
            }, concurrency);
        }
    }
    else {
        console.log(`Skipping summaries for ${unprocessed.length} conversations (--no-summaries mode)\n`);
    }
    // Now index embeddings
    console.log(`\nIndexing embeddings...`);
    for (const conv of unprocessed) {
        for (const exchange of conv.exchanges) {
            const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
            const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
            await provider.insertExchange(exchange, embedding, toolNames);
        }
    }
    await closeProvider();
    console.log(`\n✅ Processed ${unprocessed.length} conversations`);
}
