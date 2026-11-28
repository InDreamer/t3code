import { PA_BOTS_MARK_PATH, PA_BOTS_MARK_VIEWBOX } from "@t3tools/client-runtime/pa/avatar";
import type { Icon, IconProps } from "@tabler/icons-react-native/types";
import { forwardRef } from "react";
import Svg, { Path } from "react-native-svg";

/** The Bots tab icon: a line icon on the same 24-grid and stroke as the Tabler icons beside it. */
export const PaBotsMark: Icon = forwardRef<Svg, IconProps>(function PaBotsMark(
  { size = 24, color = "black", strokeWidth = 2, title: _title, ...rest },
  ref,
) {
  return (
    <Svg
      ref={ref}
      width={size}
      height={size}
      viewBox={PA_BOTS_MARK_VIEWBOX}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <Path d={PA_BOTS_MARK_PATH} />
    </Svg>
  );
});
