/** Image file types the app renders visually (<img>) instead of as text/diff. */
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
  "apng",
]);

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  // The dot must live in the last segment — "dir.v2/README" is not an image.
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}
