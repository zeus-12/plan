/**
 * Tunables for the main process.
 *
 * Keep these in SCREAMING_SNAKE_CASE so they're trivial to grep for and
 * obviously knobs rather than computed state.
 */

/**
 * How deep we scan inside a non-git project directory looking for nested
 * git repos. `1` means: if the project itself isn't a git repo, look at its
 * immediate child directories. `0` disables nested-repo discovery.
 */
export const GIT_SCAN_DEPTH = 1;
