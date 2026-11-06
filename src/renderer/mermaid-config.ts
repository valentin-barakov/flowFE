// Settings for mermaid and two small helpers for showing its SVG. No DOM, no mermaid import at run time.
import type { MermaidConfig } from "mermaid";

/**
 * `strict` makes mermaid sanitize labels and turn off click handlers. Labels are plain SVG text
 * (no HTML labels), so the SVG can be shown through an <img>, where it cannot run script.
 */
export function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  };
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Width from the SVG's viewBox, so a small diagram is not stretched to the full width. */
export function svgWidth(svg: string): number | null {
  const match = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+\s*"/.exec(svg);
  if (match === null) return null;
  const width = Number(match[1]);
  return Number.isFinite(width) && width > 0 ? Math.ceil(width) : null;
}
