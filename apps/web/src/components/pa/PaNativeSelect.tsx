import type { ComponentProps } from "react";

/** Native, so phones get the system picker; a 16px floor on touch keeps iOS from zooming in. */
export function PaNativeSelect(props: Omit<ComponentProps<"select">, "className">) {
  return (
    <select
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm pointer-coarse:text-(length:--font-size-input-touch)"
      {...props}
    />
  );
}
