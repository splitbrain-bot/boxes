"use client";

import { type ComponentPropsWithRef, forwardRef } from "react";
import { Slot } from "radix-ui";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The props of {@link TooltipIconButton}: any button prop, the tooltip text and its side. */
export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  /** The tooltip text. It is also the accessible name of the button. */
  tooltip: string;
  /** The side of the button that the tooltip opens on. */
  side?: "top" | "bottom" | "left" | "right";
};

/**
 * A small ghost icon button with a tooltip that opens at once.
 *
 * @param props The icon, the tooltip, its side, the classes and the other button props.
 * @param ref The ref to the button element.
 */
export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(({ children, tooltip, side = "bottom", className, ...rest }, ref) => {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            {...rest}
            className={cn(
              "aui-button-icon size-6 p-1 active:scale-90",
              className,
            )}
            ref={ref}
          >
            <Slot.Slottable>{children}</Slot.Slottable>
            <span className="aui-sr-only sr-only">{tooltip}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

TooltipIconButton.displayName = "TooltipIconButton";
