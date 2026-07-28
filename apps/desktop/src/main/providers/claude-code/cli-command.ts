/** How the `claude` binary is invoked to start or resume one chat. */
export function claudeStartCommand(opts: {
  sessionId: string;
  isNew: boolean;
  autoMode: boolean;
}): string {
  const flags = opts.autoMode ? " --permission-mode auto" : "";
  // A brand-new chat has no transcript to resume, so we hand Claude the id we
  // already minted for it; an existing one resumes by that id.
  return opts.isNew
    ? `claude --session-id ${opts.sessionId}${flags}`
    : `claude --resume ${opts.sessionId}${flags}`;
}
