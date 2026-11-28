import { PA_BOTS_MARK_PATH, PA_BOTS_MARK_VIEWBOX } from "@t3tools/client-runtime/pa/avatar";
import type { SVGProps } from "react";

/** The Bots entry icon, drawn as a line icon so it sits beside Lucide icons at the same weight. */
export function PaBotsMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={PA_BOTS_MARK_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d={PA_BOTS_MARK_PATH} />
    </svg>
  );
}
