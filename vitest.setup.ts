// Claude-home lookups fall back to the environment Ness was launched
// with, so a developer whose shell points CLAUDE_CONFIG_DIR elsewhere
// would otherwise see every ~/.claude-based fixture miss.
delete process.env.CLAUDE_CONFIG_DIR
