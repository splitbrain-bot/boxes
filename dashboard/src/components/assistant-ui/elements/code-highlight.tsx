"use client";

import { type CSSProperties, type FC, Fragment, useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

import { type Token, tokenizeLines } from "@/lib/highlight";

/**
 * Shows a code block with syntax colouring.
 *
 * While the message is still streaming, the block shows plain text, so a
 * growing block is not tokenized again for each change. The block also stays
 * plain when no grammar exists for its language, or when the code is too long
 * to tokenize.
 *
 * @param code The code of the block.
 * @param language The language from the info string of the code fence.
 * @param components The Pre and Code components that show the code.
 */
export const CodeHighlight: FC<SyntaxHighlighterProps> = ({
  code,
  language,
  components: { Pre, Code },
}) => {
  const streaming = useAuiState((s) => s.part.status.type === "running");
  const [result, setResult] = useState<{
    code: string;
    language: string;
    lines: Token[][] | null;
  }>();

  useEffect(() => {
    if (streaming) return;
    let current = true;
    tokenizeLines(code, language).then(
      (lines) => current && setResult({ code, language, lines }),
    );
    return () => {
      current = false;
    };
  }, [code, language, streaming]);

  // A result for other code or another language is stale.
  const lines =
    result?.code === code && result.language === language
      ? result.lines
      : null;

  return (
    // Pre renders again only for a new markdown node, so the key makes it show the colours.
    <Pre key={lines ? "highlighted" : "plain"}>
      <Code>
        {lines
          ? lines.map((tokens, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id, and the block is replaced whole
              <Fragment key={i}>
                {i > 0 && "\n"}
                {tokens.map((token, j) => (
                  // The span carries both theme colours, and the stylesheet picks one.
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no id, and a line is replaced whole
                  <span key={j} style={token.style as CSSProperties}>
                    {token.content}
                  </span>
                ))}
              </Fragment>
            ))
          : code}
      </Code>
    </Pre>
  );
};
