/**
 * Helper to convert raw DB row to ConversationExchange
 */
export function rowToExchange(row) {
    return {
        id: row.id,
        project: row.project,
        timestamp: row.timestamp,
        userMessage: row.user_message,
        assistantMessage: row.assistant_message,
        archivePath: row.archive_path,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        parentUuid: row.parent_uuid,
        isSidechain: row.is_sidechain,
        sessionId: row.session_id,
        cwd: row.cwd,
        gitBranch: row.git_branch,
        claudeVersion: row.claude_version,
        thinkingLevel: row.thinking_level,
        thinkingDisabled: row.thinking_disabled,
        thinkingTriggers: row.thinking_triggers,
    };
}
