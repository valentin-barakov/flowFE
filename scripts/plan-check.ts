// Checks the createPlan name match and the markdown options. No network and no Electron.
//   node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/plan-check.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownOptions, mermaidSource } from "../src/renderer/markdown-config.ts";
import { mermaidConfig, svgDataUrl, svgWidth } from "../src/renderer/mermaid-config.ts";
import { isCreatePlan } from "../src/shared/plan-markdown.ts";

function render(text: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { ...markdownOptions, children: text }));
}

test("createPlan names match after case and separators", () => {
  assert.equal(isCreatePlan("createPlan"), true);
  assert.equal(isCreatePlan("CreatePlan"), true);
  assert.equal(isCreatePlan("create_plan"), true);
  assert.equal(isCreatePlan("create-plan"), true);
  assert.equal(isCreatePlan("plan"), false);
});

test("a table becomes table markup", () => {
  const html = render("| Plan | Status |\n|---|---|\n| one | done |\n");
  assert.match(html, /<table>/);
  assert.match(html, /<th>Plan<\/th>/);
  assert.match(html, /<td>done<\/td>/);
});

test("bold, italics, inline code, and a list render", () => {
  const html = render("**bold** and *it* and `code`\n\n- one\n- two\n");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>it<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul>/);
});

test("a header row with no separator row stays a paragraph while the table streams", () => {
  const html = render("| a | b |\n");
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /a/);
});

test("an unclosed fence keeps the rest as code", () => {
  const html = render("```\nline\n");
  assert.match(html, /<pre>/);
  assert.match(html, /line/);
});

test("raw HTML is not rendered as markup", () => {
  const html = render("<script>alert(1)</script>\n\nhi");
  assert.doesNotMatch(html, /<script/);
});

test("images are dropped and a script link is not kept", () => {
  const image = render("![x](https://evil.test/a.png)");
  assert.doesNotMatch(image, /<img/);
  assert.match(image, />x</);
  assert.doesNotMatch(render("[x](javascript:alert(1))"), /javascript:/);
});

test("a mermaid fence reaches the renderer as code with the mermaid language class", () => {
  const html = render("```mermaid\nflowchart LR\n  a --> b\n```\n");
  assert.match(html, /<code class="language-mermaid">/);
});

test("only a non-empty mermaid fence is a diagram", () => {
  assert.equal(mermaidSource("language-mermaid", "flowchart LR\n  a --> b\n"), "flowchart LR\n  a --> b");
  assert.equal(mermaidSource("foo language-mermaid", "pie\n  \"a\": 1"), "pie\n  \"a\": 1");
  assert.equal(mermaidSource("language-ts", "const n = 1;"), null);
  assert.equal(mermaidSource(undefined, "flowchart LR"), null);
  assert.equal(mermaidSource("language-mermaid", "  \n"), null);
  assert.equal(mermaidSource("language-mermaidx", "flowchart LR"), null);
});

test("the diagram config is strict, draws plain SVG text, and follows the theme", () => {
  const light = mermaidConfig(false);
  assert.equal(light.securityLevel, "strict");
  assert.equal(light.startOnLoad, false);
  assert.equal(light.theme, "default");
  assert.equal(light.htmlLabels, false);
  assert.equal(light.flowchart?.htmlLabels, false);
  assert.equal(mermaidConfig(true).theme, "dark");
});

test("an SVG becomes a data URL that decodes back to the same markup", () => {
  const svg = '<svg viewBox="0 0 10 10"><text>a & b</text></svg>';
  const url = svgDataUrl(svg);
  assert.equal(url.startsWith("data:image/svg+xml;charset=utf-8,"), true);
  assert.equal(decodeURIComponent(url.slice(url.indexOf(",") + 1)), svg);
});

test("svgWidth reads the width from the viewBox", () => {
  assert.equal(svgWidth('<svg viewBox="0 0 345.5 120">'), 346);
  assert.equal(svgWidth('<svg viewBox="-8 -8 100.2 50">'), 101);
  assert.equal(svgWidth("<svg>"), null);
});
