/**
 * Builds the launcher (launcher/claude-swap-launcher.cs) with the C# compiler that
 * ships with .NET Framework 4 on Windows 10 and 11, and installs it in the data
 * root, where Anthropic's `claudeCode.claudeProcessWrapper` setting can point at
 * it for good.
 *
 * Not in the extension's own folder: that folder is renamed on every extension
 * update (…-0.1.3 → …-0.1.4), and a setting left pointing at a deleted program
 * stops Claude from starting in every window. The data root also outlives an
 * uninstall, so a forgotten setting keeps working: with no folder map the launcher
 * changes nothing.
 *
 * Node-only (no `vscode` import), so the tests build and run the real thing.
 */

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const LAUNCHER_EXE = 'claude-swap-launcher.exe';

/** Where launcher, folder map, login folders, session and window records live. */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'ClaudeSwapVSCode');
}

export function launcherPath(root: string): string {
  return path.join(root, 'launcher', LAUNCHER_EXE);
}

/** The .NET Framework 4 C# compiler, which every supported Windows has. */
export function findCsc(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  for (const framework of ['Framework64', 'Framework']) {
    const csc = path.join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) {
      return csc;
    }
  }
  return undefined;
}

/**
 * Make sure an up-to-date launcher is installed; rebuild when the source changed.
 *
 * Replacing a launcher that is running (any open Claude tab holds one) cannot
 * delete it, since Windows locks a running program's file, but it can rename it.
 * So the old file is renamed aside and the new one moved into place, and leftovers
 * are cleared on a later build once nothing runs them.
 */
export async function installLauncher(
  sourceFile: string,
  root: string
): Promise<{ exe: string; rebuilt: boolean }> {
  const source = fs.readFileSync(sourceFile);
  const hash = createHash('sha256').update(source).digest('hex');
  const dir = path.join(root, 'launcher');
  const exe = path.join(dir, LAUNCHER_EXE);
  const stamp = path.join(dir, 'source.sha256');
  fs.mkdirSync(dir, { recursive: true });
  clearLeftovers(dir);

  if (fs.existsSync(exe) && readText(stamp) === hash) {
    return { exe, rebuilt: false };
  }

  const csc = findCsc();
  if (!csc) {
    throw new Error(
      "Windows' built-in C# compiler (part of .NET Framework 4) was not found, so the launcher cannot be built on this computer."
    );
  }
  const built = path.join(dir, `build-${process.pid}-${Date.now()}.exe`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      csc,
      ['/nologo', '/target:exe', '/optimize+', '/platform:anycpu', `/out:${built}`, sourceFile],
      { timeout: 120_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stdout}\n${stderr}`.trim() || err.message;
          reject(new Error(`The launcher could not be built: ${detail}`));
          return;
        }
        resolve();
      }
    );
  });

  if (fs.existsSync(exe)) {
    try {
      fs.unlinkSync(exe);
    } catch {
      fs.renameSync(exe, `${exe}.old-${Date.now()}`);
    }
  }
  fs.renameSync(built, exe);
  writeAtomic(stamp, hash);
  return { exe, rebuilt: true };
}

function clearLeftovers(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (name.includes('.old-') || /^build-.*\.exe$/.test(name)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // Still running, or still being written by another window's build.
      }
    }
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Write via a temp file and a rename, so a reader (the launcher reading the folder
 * map at Claude's start, another window reading a record) never sees half a file.
 */
export function writeAtomic(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (err) {
      // A reader holding the file open makes Windows refuse the replace briefly.
      if (attempt >= 20) {
        try {
          fs.unlinkSync(temp);
        } catch {
          // best effort
        }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
