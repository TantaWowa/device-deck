import type { Device, InputEntry, Settings } from "./demo/model";
export const artwork = `${import.meta.env?.BASE_URL || "/"}assets/fjord-preview.webp`;
const titles = ["Above the fjord", "The quiet coast", "Into the mountains"];
export function SampleScreen({
  device,
  issue = "",
  last,
  overlay = false,
  compact = false,
}: {
  device: Device;
  issue?: string;
  last?: InputEntry;
  overlay?: boolean;
  compact?: boolean;
}) {
  const index = last?.screenIndex || 0;
  return (
    <div
      className={`sample-screen ${compact ? "compact" : ""}`}
      data-device={device.id}
    >
      {issue ? (
        <div className="screen-unavailable">
          <span>Preview unavailable</span>
          <strong>{issue}</strong>
          <small>Configure an online source to see the sample preview.</small>
        </div>
      ) : (
        <>
          <img
            src={artwork}
            alt="Fictional landscape used for the simulated device input"
          />
          <div className="screen-shade" />
          <div className="sample-nav">
            <b>FIELDNOTES</b>
            <span>Discover</span>
            <span>Films</span>
            <span>My list</span>
          </div>
          <div className="sample-title">
            <small>A FIELDNOTES ORIGINAL</small>
            <h3>{titles[index]}</h3>
            <p>Some places are worth slowing down for.</p>
            <span className="sample-play">▶ Play film</span>
          </div>
          <div className="sample-cards">
            {titles.map((t, i) => (
              <span key={t} className={i === index ? "focused" : ""}>
                {t}
              </span>
            ))}
          </div>
          <span className="screen-caption">Fictional app · sample image</span>
          {overlay && last && (
            <div className="key-overlay">
              <span>SIMULATED INPUT</span>
              <b>{last.key}</b>
              <small>
                {device.name}
                {last.elapsedMs !== null
                  ? ` · +${(last.elapsedMs / 1000).toFixed(1)}s`
                  : " · outside recording"}
              </small>
            </div>
          )}
        </>
      )}
    </div>
  );
}
export async function sampleBlob(
  device: Device,
  mode: Settings["captureMode"],
  last?: InputEntry,
) {
  const img = new Image();
  img.src = artwork;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, 1280, 720);
  ctx.fillStyle = "#07101bbf";
  ctx.fillRect(0, 590, 1280, 130);
  ctx.fillStyle = "#fff";
  ctx.font = "28px system-ui";
  ctx.fillText("Device Deck · SAMPLE IMAGE", 35, 640);
  ctx.font = "20px system-ui";
  ctx.fillText(`${device.name} · simulated capture`, 35, 678);
  if (mode === "annotated") {
    ctx.fillStyle = "#07101bdd";
    ctx.fillRect(820, 28, 430, 105);
    ctx.fillStyle = "#fff";
    ctx.font = "24px system-ui";
    ctx.fillText(`Input: ${last?.key || "No input yet"}`, 845, 70);
    ctx.font = "18px system-ui";
    ctx.fillText(
      last?.elapsedMs != null
        ? `Recording +${(last.elapsedMs / 1000).toFixed(1)}s`
        : "Outside recording",
      845,
      107,
    );
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b
          ? resolve(b)
          : reject(new Error("Sample image could not be created.")),
      "image/png",
    ),
  );
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
