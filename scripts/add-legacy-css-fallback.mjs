import { readFile, writeFile } from "node:fs/promises";
import postcss from "postcss";

const cssPath = new URL("../dist/app.css", import.meta.url);
const pluginRoot = ':where([data-bb-plugin="wakatime"], [data-bb-plugin-root]:not([data-bb-plugin]))';

function splitSelectors(value) {
  const selectors = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(value.slice(start).trim());
  return selectors.filter(Boolean);
}

function combineSelectors(parents, children) {
  if (!parents) return children;
  return parents.flatMap((parent) => children.map((child) =>
    child.includes("&") ? child.replaceAll("&", parent) : `${parent} ${child}`,
  ));
}

function legacyMediaParams(params) {
  return params
    .replace(/\(width\s*>=\s*([^\)]+)\)/g, "(min-width: $1)")
    .replace(/\(width\s*<=\s*([^\)]+)\)/g, "(max-width: $1)");
}

function prefixedSelectors(selectors) {
  return selectors.flatMap((selector) => [
    `${pluginRoot} ${selector}`,
    `${pluginRoot}${selector}`,
  ]).join(",\n");
}

function appendRule(target, selectors, declarations, wrappers) {
  if (declarations.length === 0 || !selectors) return;
  const rule = postcss.rule({ selector: prefixedSelectors(selectors) });
  declarations.forEach((declaration) => rule.append(declaration.clone()));

  let node = rule;
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    const wrapper = wrappers[index];
    const atRule = postcss.atRule({
      name: wrapper.name,
      params: wrapper.name === "media" ? legacyMediaParams(wrapper.params) : wrapper.params,
    });
    atRule.append(node);
    node = atRule;
  }
  target.append(node);
}

function flattenContainer(container, target, parents = null, wrappers = []) {
  const declarations = (container.nodes ?? []).filter((node) => node.type === "decl");
  appendRule(target, parents, declarations, wrappers);

  for (const child of container.nodes ?? []) {
    if (child.type === "rule") {
      flattenContainer(
        child,
        target,
        combineSelectors(parents, splitSelectors(child.selector)),
        wrappers,
      );
    } else if (child.type === "atrule" && child.nodes) {
      flattenContainer(child, target, parents, [...wrappers, { name: child.name, params: child.params }]);
    }
  }
}

const source = await readFile(cssPath, "utf8");
const root = postcss.parse(source, { from: cssPath.pathname });
const scopes = [];
root.walkAtRules("scope", (rule) => scopes.push(rule));

if (scopes.length === 0) {
  let hasPrefixedRules = false;
  root.walkRules((rule) => {
    if (/\[data-bb-plugin=(?:"wakatime"|wakatime)\]/.test(rule.selector)) {
      hasPrefixedRules = true;
    }
  });
  if (!hasPrefixedRules) {
    throw new Error("bb's generated plugin scope was not found; refusing to emit an incomplete fallback");
  }
  console.log("CSS is already flattened and plugin-prefixed; legacy fallback is not needed.");
  process.exit(0);
}

const fallback = postcss.root();
fallback.append(postcss.comment({
  text: "Legacy fallback for webviews without CSS @scope or native nesting",
}));
for (const scope of scopes) flattenContainer(scope, fallback);

await writeFile(cssPath, `${source.trimEnd()}\n${fallback.toString()}\n`);
