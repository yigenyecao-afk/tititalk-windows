import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "uptodate" }
  | { state: "available"; version: string; notes?: string; update: Update }
  | { state: "downloading"; version: string; bytes: number; total?: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    const u = await check();
    if (!u) return { state: "uptodate" };
    return {
      state: "available",
      version: u.version,
      notes: u.body ?? undefined,
      update: u,
    };
  } catch (e) {
    return { state: "error", message: String(e) };
  }
}

export async function downloadAndInstall(
  update: Update,
  onProgress?: (bytes: number, total?: number) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? undefined;
        onProgress?.(0, total);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
        break;
      case "Finished":
        onProgress?.(total ?? downloaded, total);
        break;
    }
  });
}

export async function restart(): Promise<void> {
  await relaunch();
}
