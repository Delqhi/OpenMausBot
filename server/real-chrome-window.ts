// Real-chrome window choreography for the durable control lease.
//
// When the real-chrome backend drives a per-bot Google Chrome (separate
// Chrome process, --user-data-dir=…/profiles/<botId>), the human takeover
// choreography needs the OS window to follow the lease: TAKE brings that
// Chrome window frontmost and full-size, RELEASE parks it as a small window
// in the top-right corner so the OpenMausBot app is visible again.
//
// Implementation: the cua-driver daemon (which owns macOS Accessibility and
// Screen Recording for this setup) exposes window management tools via its
// CLI (`list_windows`, `bring_to_front`, `set_window_frame`) — using it
// instead of raw osascript keeps the TCC attribution on com.trycua.driver,
// whose grants the operator already made.
//
// Scope guard: only fires when OPENMAUSBOT_REAL_CHROME=1 AND the bot's main
// Chrome process actually exists — bots on other computer destinations are
// untouched. Helper processes (renderer/GPU/crashpad) inherit
// `--user-data-dir` in their command lines, so the PID selection must
// narrow to the main binary and to the window whose title is non-empty.

import { execFile } from "node:child_process";

const DRIVER = process.env.CUA_DRIVER_PATH
  ?? "/Users/jeremyschulze/.local/share/sin-runtime/openmausbot/OpenMausBot/dist-native/arm64/cua-driver";

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function callToolJson(tool: string, argsJson: string, timeoutMs = 12_000): Promise<string> {
  return run(DRIVER, ["call", tool, "--json", argsJson], timeoutMs);
}

/** PID of the bot's own Chrome MAIN process, or null when it is not
 * running. Helpers inherit `--user-data-dir` in their command lines, so the
 * pgrep match must be narrowed to the main binary path. */
async function chromePidForBot(botId: string): Promise<number | null> {
  try {
    const out = await run("pgrep", ["-f", `--user-data-dir=.*profiles/${botId}`], 5_000);
    for (const candidate of out.trim().split("\n")) {
      const pid = Number(candidate);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try {
        const command = await run("ps", ["-p", String(pid), "-o", "command="], 5_000);
        const line = command.trim();
        if (line.includes("MacOS/Google Chrome ") || line.endsWith("MacOS/Google Chrome")) return pid;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

interface WindowRow {
  window_id: number;
  title: string;
  is_on_screen: boolean;
  bounds: { width: number; height: number };
}

/** The bot's real content window: titled and the largest on-screen one.
 * Chrome keeps ~10 auxiliary windows (1×1 render surfaces, 30px toolbars)
 * that are not the page. */
async function contentWindow(pid: number): Promise<WindowRow | null> {
  const raw = await callToolJson("list_windows", JSON.stringify({ pid }));
  const parsed = JSON.parse(raw) as { windows?: WindowRow[] };
  const candidates = (parsed.windows ?? []).filter(
    (window) => (window.title ?? "").trim().length > 0,
  );
  if (!candidates.length) return null;
  return candidates.reduce((best, window) =>
    window.bounds.width * window.bounds.height > best.bounds.width * best.bounds.height ? window : best,
  );
}

async function parseCall(raw: string): Promise<unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Fire-and-forget window choreography for one control transition. Never
 * throws — a missing window or a driver hiccup must not fail the lease;
 * the panel and the lease state stay authoritative. */
export async function chromeWindowChoreography(botId: string, action: "take" | "release"): Promise<void> {
  try {
    const pid = await chromePidForBot(botId);
    if (!pid) return;
    const window = await contentWindow(pid);
    if (!window) return;
    if (action === "take") {
      // raise first (AX route), then size — the readback in set_window_frame
      // needs the window mapped.
      await parseCall(await callToolJson("bring_to_front", JSON.stringify({ pid, window_id: window.window_id })));
      await parseCall(await callToolJson("set_window_frame", JSON.stringify({
        pid,
        window_id: window.window_id,
        x: 0,
        y: 25,
        width: 1920,
        height: 1055,
      })));
    } else {
      // park top-right, small; drop below the app in z-order
      await parseCall(await callToolJson("set_window_frame", JSON.stringify({
        pid,
        window_id: window.window_id,
        x: 1420,
        y: 40,
        width: 500,
        height: 340,
      })));
    }
  } catch {
    // best-effort; the lease state and the panel stay authoritative
  }
}
