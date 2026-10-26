/**
 * extras — turning files the host picked into material a team can read.
 *
 * Documents become text (`extract.ts`); pictures become a file in the team's
 * folder plus a pointer a seat can open (`image.ts`). Nothing here decides
 * what a round carries — that is the table's.
 */
import { extractDocument } from "./extract.ts";
import { imagePointer, looksLikeImage, saveImage } from "./image.ts";

export { extractDocument, MAX_FILE_BYTES } from "./extract.ts";
export { imagePointer, looksLikeImage, readMedia, saveImage } from "./image.ts";
export { bannerFor, previewOf, quietBanner, type Banner } from "./notify.ts";
export { BACKEND_TOOLS, createBackendTools, type BackendTool } from "./backend-tools.ts";
export { speak, speechEndpointFor, transcribe, transcriptionEndpointFor, type VoiceConnection } from "./voice.ts";

/**
 * One picked or pasted file, as the material it becomes. A picture is written
 * under the project folder first, because what a seat receives is its PATH.
 */
export async function materialFromFile(
  projectFolder: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ readonly name: string; readonly text: string }> {
  if (looksLikeImage(name)) {
    const path = await saveImage(projectFolder, name, bytes);
    return { name, text: imagePointer(path) };
  }
  return extractDocument(name, bytes);
}
