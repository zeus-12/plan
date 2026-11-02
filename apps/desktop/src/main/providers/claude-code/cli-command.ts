export function claudeStartCommand(opts: {
  sessionId: string;
  isNew: boolean;
  autoMode: boolean;
}): string {
  const flags = opts.autoMode ? " --permission-mode auto" : "";
  const sessionArgs = opts.isNew
    ? `--session-id ${opts.sessionId}`
    : `--resume ${opts.sessionId}`;
  return `export CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 && claude ${sessionArgs}${flags}`;
}
