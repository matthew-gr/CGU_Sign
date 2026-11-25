// pdf-lib standard fonts only support WinAnsi; replace common typographic characters.
export const clean = (s: string) =>
  s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/·/g, "-")
    .replace(/[^\x0A\x20-\x7E\xA0-\xFF]/g, "");