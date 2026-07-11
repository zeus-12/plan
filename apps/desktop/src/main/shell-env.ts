import { app } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Shell + environment for app-spawned ptys — owns the "styled zsh without
 * touching dotfiles" mechanism so terminal.ts just asks for a shell and an env.
 */

export function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

/**
 * App-scoped zsh styling WITHOUT touching the user's dotfiles. We point zsh at
 * our own `ZDOTDIR`; each file there sources the user's real equivalent first
 * (so their PATH/aliases/plugins load unchanged), then our `.zshrc` layers the
 * terminal's prompt + colours on top. Only ptys spawned by this app get it;
 * every other terminal on the machine is unaffected. This is the same mechanism
 * VS Code uses for its shell integration.
 *
 * Returns the dir to use as `ZDOTDIR`, or null for non-zsh shells (where we
 * leave the environment completely alone).
 */
let cachedZdotdir: string | null | undefined;
function shellZdotdir(): string | null {
  if (cachedZdotdir !== undefined) return cachedZdotdir;
  cachedZdotdir = null;
  if (!/(^|\/)zsh$/.test(defaultShell())) return null;
  try {
    const dir = join(app.getPath("userData"), "shell", "zdotdir");
    mkdirSync(dir, { recursive: true });
    // Chain to the user's real startup files (ZDOTDIR stays ours, so zsh keeps
    // reading our files; each one pulls in the user's before we add anything).
    const chain = (name: string) =>
      `[[ -f "\${USER_ZDOTDIR:-$HOME}/${name}" ]] && source "\${USER_ZDOTDIR:-$HOME}/${name}"\n`;
    writeFileSync(join(dir, ".zshenv"), chain(".zshenv"));
    writeFileSync(join(dir, ".zprofile"), chain(".zprofile"));
    writeFileSync(join(dir, ".zlogin"), chain(".zlogin"));
    writeFileSync(
      join(dir, ".zshrc"),
      chain(".zshrc") +
        [
          "# Plan terminal styling — scoped to this app; your ~/.zshrc is untouched.",
          "export CLICOLOR=1",
          "export LSCOLORS=cxfxcxdxbxegedabagacad",
          // Full cwd (home shown as ~) in one soft tint, dim prompt symbol.
          "PROMPT='%F{108}%~%f %F{244}%#%f '",
          "",
        ].join("\n"),
    );
    cachedZdotdir = dir;
  } catch {
    cachedZdotdir = null;
  }
  return cachedZdotdir;
}

/** Environment for a spawned pty: the app's env plus TERM and the ZDOTDIR
 *  styling chain (zsh only). */
export function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
  };
  // Point zsh at our app-owned ZDOTDIR (which chains to the user's real
  // config) so the prompt/colours live in the app, not the user's dotfiles.
  const zdotdir = shellZdotdir();
  if (zdotdir) {
    // Point at the user's REAL config dir. If we were launched from inside one
    // of our own terminals, the inherited ZDOTDIR is already ours — using it
    // would make our .zshrc source itself forever, so fall back to the real
    // dir the parent stashed in USER_ZDOTDIR (then $HOME).
    const inherited = process.env.ZDOTDIR;
    const realUserDir =
      inherited && inherited !== zdotdir ? inherited : process.env.USER_ZDOTDIR;
    env.USER_ZDOTDIR = realUserDir || process.env.HOME || "";
    env.ZDOTDIR = zdotdir;
  }
  return env;
}
