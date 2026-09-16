/** Start the browser write during the click; Safari requires activation before capture/network awaits. */
export async function copyImageToClipboard(loadPng: () => Promise<Blob>): Promise<void> {
  if (!globalThis.isSecureContext || !globalThis.navigator?.clipboard?.write || !globalThis.ClipboardItem)
    throw new Error("Image clipboard needs HTTPS (such as your Tailscale HTTPS address) or localhost, and a browser that supports copying images. You can still save and download a screenshot.");
  let captureError: unknown;
  const png = Promise.resolve().then(loadPng).then((blob) => {
    if (blob.type !== "image/png") throw new Error("The screenshot is not a PNG image.");
    return blob;
  }).catch((error) => { captureError = error; throw error; });
  // Permission can be rejected before the browser reads the deferred image.
  void png.catch(() => {});
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch (error) {
    if (captureError) throw captureError;
    throw new Error("Could not copy the image. Allow clipboard access in this browser, then use Copy image in the capture preview. Your screenshot will still be saved in Captures.", { cause: error });
  }
}
