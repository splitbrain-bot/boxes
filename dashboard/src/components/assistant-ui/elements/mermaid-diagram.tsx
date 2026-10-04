"use client";

import { type FC, useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

import { ImageZoom } from "@/components/assistant-ui/elements/image";
import { useMediaQuery } from "@/hooks/use-media-query";

/** Counts renders, so every diagram gets an id of its own. */
let renders = 0;

/**
 * The render that runs now. Mermaid's configuration is global, so a render
 * waits for the one before it.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Renders mermaid source to an SVG image.
 *
 * Mermaid is imported here, so a thread without a diagram never loads it.
 * The SVG gets its size from the view box, because an image without a size
 * would show at a default width.
 *
 * @param code The mermaid source.
 * @param dark Whether to use the dark theme.
 * @returns The SVG as a data URL.
 * @throws When mermaid cannot parse the source.
 */
const renderDiagram = (code: string, dark: boolean): Promise<string> => {
  const job = queue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
    });
    renders += 1;
    const { svg } = await mermaid.render(`mermaid-diagram-${renders}`, code);

    const root = new DOMParser().parseFromString(
      svg,
      "image/svg+xml",
    ).documentElement;
    const [, , width, height] = (root.getAttribute("viewBox") ?? "").split(
      /[\s,]+/,
    );
    if (width && height) {
      root.setAttribute("width", width);
      root.setAttribute("height", height);
      root.style.removeProperty("max-width");
    }
    const xml = new XMLSerializer().serializeToString(root);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
  queue = job.catch(() => undefined);
  return job;
};

/**
 * Shows a mermaid code block as a diagram.
 *
 * While the message is still streaming, and when the source does not parse,
 * the block shows its source text. A tap opens the diagram in the full screen
 * view that images use, where the browser's own pinch zoom works.
 */
export const MermaidDiagram: FC<SyntaxHighlighterProps> = ({
  code,
  components: { Pre, Code },
}) => {
  const streaming = useAuiState((s) => s.part.status.type === "running");
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  const [result, setResult] = useState<{
    code: string;
    dark: boolean;
    src?: string;
  }>();

  useEffect(() => {
    if (streaming) return;
    let current = true;
    renderDiagram(code, dark).then(
      (src) => current && setResult({ code, dark, src }),
      () => current && setResult({ code, dark }),
    );
    return () => {
      current = false;
    };
  }, [code, dark, streaming]);

  // A result for other source or the other theme is stale.
  const done = result?.code === code && result.dark === dark;

  if (done && result.src) {
    return (
      <div className="aui-md-mermaid aui-md-bleed border-border/50 rounded-b-xl border border-t-0 p-3.5">
        <ImageZoom
          src={result.src}
          alt="Diagram"
          // The diagram is drawn on a transparent background, and grows to
          // fill the screen.
          contentClassName="bg-background h-auto w-[90vw] rounded-lg p-3"
        >
          <img
            src={result.src}
            alt="Diagram"
            className="mx-auto block h-auto max-w-full"
          />
        </ImageZoom>
      </div>
    );
  }

  return (
    <>
      <Pre>
        <Code>{code}</Code>
      </Pre>
      {done && (
        <p className="aui-md-mermaid-error text-muted-foreground mt-1 text-xs">
          This diagram could not be drawn.
        </p>
      )}
    </>
  );
};
