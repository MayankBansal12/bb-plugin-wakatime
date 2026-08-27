/*
 * An older webview shipped by bb drops every CSS rule whose selector carries a
 * backslash escape, which is exactly what Tailwind emits for arbitrary values
 * (`text-[44px]` -> `.text-\[44px\]`) and fractional spacing (`gap-1.5` ->
 * `.gap-1\.5`). The page still renders, so the breakage is silent: icons fall
 * back to the replaced-element default size and the type scale collapses.
 *
 * This fails the build if such a class reappears in the plugin's own source.
 * Responsive prefixes (`md:`) are allowed — they also escape, but they degrade
 * to the unprefixed layout rather than to something broken.
 */
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const ALLOWED_PREFIXES = ["sm:", "md:", "lg:", "xl:", "hover:", "focus:", "focus-visible:", "active:", "disabled:", "first:", "last:", "dark:", "group-hover:"];

// class="..." / className="..." string literals
const CLASS_ATTR = /class(?:Name)?\s*=\s*"([^"]*)"/g;
// cn("...", "...") arguments
const STRING_LITERAL = /"([^"\n]*)"/g;

function offenders(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      const bare = ALLOWED_PREFIXES.reduce((rest, prefix) =>
        rest.startsWith(prefix) ? rest.slice(prefix.length) : rest, token);
      // arbitrary value, fractional spacing, or a fraction like w-1/2
      return /\[|\]/.test(bare) || /^-?[a-z-]+-\d+\.\d/.test(bare) || /^-?[a-z-]+-\d+\/\d+$/.test(bare);
    });
}

const files = [];
for await (const entry of glob(["app.tsx", "components/ui/*.tsx"])) files.push(entry);

let failures = 0;
for (const file of files) {
  const source = await readFile(file, "utf8");
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const found = new Set();
    for (const match of line.matchAll(CLASS_ATTR)) offenders(match[1]).forEach((t) => found.add(t));
    // cn(...) call arguments are class strings too
    if (/\bcn\(/.test(line)) {
      for (const match of line.matchAll(STRING_LITERAL)) offenders(match[1]).forEach((t) => found.add(t));
    }
    for (const token of found) {
      console.error(`${file}:${index + 1}  escaped-selector class "${token}" — use the standard scale or an inline style`);
      failures += 1;
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} fragile class${failures === 1 ? "" : "es"} found. See the comment at the top of app.tsx.`);
  process.exit(1);
}
console.log(`No fragile classes in ${files.length} file(s).`);
