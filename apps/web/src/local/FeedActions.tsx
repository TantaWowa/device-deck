import React from "react";
import {
  ScanLine, Camera, Circle, Square, Lock, Gamepad2, Sun,
} from "lucide-react";
import { popupAnchor, type PopupAnchor } from "./anchored-popup";
export type FeedAction =
  | "identify"
  | "record"
  | "screenshot"
  | "reserve"
  | "remote"
  | "wake";
export function FeedActions({
  name,
  recording,
  reserved,
  wakeAvailable = false,
  remoteAvailable = true,
  onAction,
}: {
  name: string;
  recording?: boolean;
  reserved?: boolean;
  wakeAvailable?: boolean;
  remoteAvailable?: boolean;
  onAction: (action: FeedAction, anchor: PopupAnchor) => void;
}) {
  return (
    <div className="feed-actions" aria-label={`Controls for ${name}`}>
      {(
        [
          ["identify", "Identify", <ScanLine size={15} />],
          [
            "record",
            recording ? "Recording" : "Record",
            recording ? <Square size={15} /> : <Circle size={15} />,
          ],
          ["screenshot", "Screenshot", <Camera size={15} />],
          ["reserve", reserved ? "Reserved" : "Reserve", <Lock size={15} />],
          ["remote", "Remote", <Gamepad2 size={16} />],
          ["wake", "Wake", <Sun size={16} />],
        ] as const
      ).filter(([id]) => id !== "remote" || remoteAvailable).map(([id, label, icon]) => (
        <button
          key={id}
          type="button"
          className={id === "record" && recording ? "is-recording" : ""}
          aria-label={`${label} · ${name}`}
          title={
            id === "wake" && !wakeAvailable
              ? "Wake unavailable for this device"
              : label
          }
          disabled={id === "wake" && !wakeAvailable}
          onClick={(event) => onAction(id, popupAnchor(event.currentTarget))}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
