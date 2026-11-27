import { useLayoutEffect, useRef } from "react";

export function useMountedRef() {
  const mounted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asynchronous replies may outlive the native sheet that should receive them
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
