import { useEffect, useRef, useState, type RefObject } from "react";
import type { Device } from "../../../../packages/core/src/local/types";
import {
  keyboardRemoteKeys,
  supportsRemoteKey,
} from "../../../../packages/core/src/remote";

const editable =
  "input,textarea,select,[contenteditable]:not([contenteditable='false']),[data-remote-action]";

export function useRemoteKeyboard({
  element,
  device,
  enabled,
  busy,
  sendKey,
}: {
  element: RefObject<HTMLElement | null>;
  device: Device;
  enabled: boolean;
  busy: boolean;
  sendKey: (key: string) => Promise<unknown>;
}) {
  const [keyboard, setKeyboard] = useState(false);
  const keyboardRef = useRef(false);
  const manuallyReleased = useRef(false);
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set());
  const pressedAt = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const current = useRef({ device, enabled, busy, sendKey });
  current.current = { device, enabled, busy, sendKey };

  const setActive = (active: boolean) => {
    keyboardRef.current = active;
    setKeyboard(active);
    if (!active) {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      pressedAt.current.clear();
      setPressedKeys(new Set());
    }
  };
  const highlight = (key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    pressedAt.current.set(key, performance.now());
    setPressedKeys((previous) => new Set([...previous, key]));
  };
  const release = (key: string) => {
    const started = pressedAt.current.get(key);
    if (started === undefined) return;
    clearTimeout(timers.current.get(key));
    timers.current.set(
      key,
      setTimeout(
        () => {
          pressedAt.current.delete(key);
          timers.current.delete(key);
          setPressedKeys((previous) => {
            const next = new Set(previous);
            next.delete(key);
            return next;
          });
        },
        Math.max(0, 160 - (performance.now() - started)),
      ),
    );
  };
  const pressKey = (key: string) => {
    const state = current.current;
    if (!state.enabled || state.busy || !supportsRemoteKey(state.device, key))
      return;
    highlight(key);
    release(key);
    void state.sendKey(key);
  };

  useEffect(() => {
    const scope =
      element.current?.closest<HTMLElement>(".floating-remote") ||
      element.current;
    if (!scope) return;
    const eligible = (target: EventTarget | null) =>
      current.current.enabled &&
      document.hasFocus() &&
      !scope.classList.contains("options-open") &&
      target instanceof Element &&
      scope.contains(target) &&
      !target.closest(editable);
    const focusIn = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(".keyboard-toggle")
      )
        return;
      if (eligible(event.target)) {
        manuallyReleased.current = false;
        setActive(true);
      } else setActive(false);
    };
    const focusOut = (event: FocusEvent) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !scope.contains(event.relatedTarget)
      )
        setActive(false);
    };
    const pointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".keyboard-toggle") && scope.contains(target)) return;
      if (!eligible(target)) {
        setActive(false);
        return;
      }
      manuallyReleased.current = false;
      // A click on the title bar or empty handset should focus the remote too.
      if (
        !target?.closest(
          "button,a,input,textarea,select,[contenteditable],[tabindex='0']",
        )
      )
        scope.focus({ preventScroll: true });
      setActive(true);
    };
    const blur = () => setActive(false);
    const focus = () => {
      if (!manuallyReleased.current && eligible(document.activeElement))
        setActive(true);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!keyboardRef.current || !current.current.enabled) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(editable)
      ) {
        setActive(false);
        return;
      }
      if (scope.classList.contains("options-open")) {
        setActive(false);
        return;
      }
      // An overlaid dialog owns input even if the remote was previously focused.
      const dialogs = Array.from(document.querySelectorAll("dialog[open]"));
      if (dialogs.length && !dialogs[dialogs.length - 1].contains(scope))
        return;
      if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing)
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        manuallyReleased.current = true;
        setActive(false);
        return;
      }
      const key =
        keyboardRemoteKeys[event.key] ||
        keyboardRemoteKeys[event.key.toLowerCase()];
      if (!key || !supportsRemoteKey(current.current.device, key)) return;
      // Prevent native Enter/Space activation of the focused button as well as
      // feed navigation. One physical key press sends one remote command.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!current.current.busy && !event.repeat) {
        highlight(key);
        void current.current.sendKey(key);
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      const key =
        keyboardRemoteKeys[event.key] ||
        keyboardRemoteKeys[event.key.toLowerCase()];
      if (key) release(key);
    };
    const observer = new MutationObserver(() => {
      if (scope.classList.contains("options-open")) setActive(false);
      else if (!manuallyReleased.current && eligible(document.activeElement))
        setActive(true);
    });
    observer.observe(scope, { attributes: true, attributeFilter: ["class"] });
    scope.addEventListener("focusin", focusIn);
    scope.addEventListener("focusout", focusOut);
    document.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp, true);
    if (!manuallyReleased.current && eligible(document.activeElement))
      setActive(true);
    return () => {
      observer.disconnect();
      scope.removeEventListener("focusin", focusIn);
      scope.removeEventListener("focusout", focusOut);
      document.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp, true);
      for (const timer of timers.current.values()) clearTimeout(timer);
    };
  }, [element, device.id]);

  useEffect(() => {
    if (!enabled) setActive(false);
    else {
      const scope =
        element.current?.closest<HTMLElement>(".floating-remote") ||
        element.current;
      const active = document.activeElement;
      if (
        !manuallyReleased.current &&
        document.hasFocus() &&
        scope &&
        !scope.classList.contains("options-open") &&
        active instanceof Element &&
        scope.contains(active) &&
        !active.closest(editable)
      )
        setActive(true);
    }
  }, [enabled]);

  return {
    keyboard,
    pressedKeys,
    pressKey,
    toggleKeyboard: () => {
      const next = !keyboardRef.current && current.current.enabled;
      manuallyReleased.current = !next;
      setActive(next);
    },
  };
}
