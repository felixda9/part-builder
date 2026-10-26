// Start ComfyUI on the GPU PC on demand, over SSH, and tunnel it to this machine.
//
// One `ssh -L` session both forwards the port and runs a small launcher on the remote PC. The
// launcher starts ComfyUI on 127.0.0.1 there (never exposed to the network) unless it is already
// running, and stops it when this session ends (stdin closes) or after COMFYUI_IDLE_MIN minutes
// without requests. Nothing is installed on the remote PC, which must run Windows with Comfy Desktop.
//
// .env: COMFYUI_SSH=user@gpu-pc  COMFYUI_SSH_KEY=~/.ssh/id_ed25519
//       COMFYUI_LOCAL_PORT=18188  COMFYUI_REMOTE_PORT=8188  COMFYUI_IDLE_MIN=30

import { type ChildProcess, spawn } from 'node:child_process';
import { log } from './paths';

export interface SshConfig {
  target: string;
  key?: string;
  localPort: number;
  remotePort: number;
  idleMinutes: number;
}

export function sshConfig(): SshConfig | null {
  const target = process.env.COMFYUI_SSH?.trim();
  if (!target) return null;
  return {
    target,
    key: process.env.COMFYUI_SSH_KEY?.trim() || undefined,
    localPort: Number(process.env.COMFYUI_LOCAL_PORT || 18188),
    remotePort: Number(process.env.COMFYUI_REMOTE_PORT || 8188),
    idleMinutes: Number(process.env.COMFYUI_IDLE_MIN ?? 30),
  };
}

/** PowerShell launcher run on the GPU PC (Comfy Desktop install). */
export function launcherScript(remotePort: number, idleMinutes: number): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
$port = ${remotePort}; $idle = ${idleMinutes}
$inst = (Get-Content "$env:APPDATA\Comfy Desktop\installations.json" -Raw | ConvertFrom-Json) | Where-Object { $_.sourceId -eq 'standalone' } | Select-Object -First 1
if (-not $inst) { 'MB-ERROR no Comfy Desktop installation found on this PC'; exit 1 }
$base = if ($inst.adoptedBaseDir) { $inst.adoptedBaseDir } else { "$HOME\Documents\ComfyUI" }
$py = @($inst.adoptedPythonPath, "$($inst.installPath)\.venv\Scripts\python.exe", "$base\.venv\Scripts\python.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$yaml = "$env:APPDATA\Comfy Desktop\instance-model-paths\$($inst.id).yaml"
$log = "$env:TEMP\part-builder-comfyui.log"
$proc = $null
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  "MB-INFO ComfyUI already running on port $port"
} else {
  $q = [char]34
  $a = @('-s', 'ComfyUI\main.py', '--listen', '127.0.0.1', '--port', "$port", '--base-directory', ($q + $base + $q), '--user-directory', ($q + "$base\user" + $q), '--disable-auto-launch')
  if (Test-Path $yaml) { $a += @('--extra-model-paths-config', ($q + $yaml + $q)) }
  $proc = Start-Process -FilePath $py -ArgumentList $a -WorkingDirectory $inst.installPath -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  "MB-INFO started ComfyUI (pid $($proc.Id)), log $log"
}
'MB-READY'
$last = Get-Date
$t = [Console]::In.ReadLineAsync()
while ($true) {
  if ($t.Wait(10000)) { if ($null -eq $t.Result) { 'MB-INFO session closed'; break }; $t = [Console]::In.ReadLineAsync() }
  if ($proc -and $proc.HasExited) { "MB-ERROR ComfyUI exited (code $($proc.ExitCode)); see $log"; break }
  if (Get-NetTCPConnection -LocalPort $port -State Established -ErrorAction SilentlyContinue) { $last = Get-Date }
  if ($idle -gt 0 -and ((Get-Date) - $last).TotalMinutes -gt $idle) { "MB-INFO idle for $idle min, stopping"; break }
}
if ($proc -and -not $proc.HasExited) { & taskkill.exe /PID $proc.Id /T /F | Out-Null; 'MB-INFO stopped ComfyUI' }
`;
}

let child: ChildProcess | null = null;
let recent: string[] = [];

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

function startSession(ssh: SshConfig): ChildProcess {
  const encoded = Buffer.from(launcherScript(ssh.remotePort, ssh.idleMinutes), 'utf16le').toString('base64');
  const args = [
    ...(ssh.key ? ['-i', ssh.key] : []),
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-L', `${ssh.localPort}:127.0.0.1:${ssh.remotePort}`,
    ssh.target,
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
  ];
  recent = [];
  // Windows OpenSSH exits silently (code 255) without %ProgramData% (its global config lives
  // there), and MCP clients may start this server with a trimmed environment.
  const env = { ...process.env, ProgramData: process.env.ProgramData ?? process.env.PROGRAMDATA ?? 'C:\\ProgramData' };
  const c = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  const keep = (b: Buffer) => {
    for (const line of b.toString().split(/\r?\n/).filter((l) => l.trim() && !/CLIXML|<Objs|<\/Objs>/.test(l))) {
      recent.push(line.trim());
      if (recent.length > 20) recent.shift();
      log(`[comfy-ssh] ${line.trim()}`);
    }
  };
  c.stdout!.on('data', keep);
  c.stderr!.on('data', keep);
  c.on('exit', (code) => { log(`[comfy-ssh] session ended (${code})`); if (child === c) child = null; });
  // Don't keep this process alive just for the session; the exit handler below closes it.
  c.unref();
  for (const s of [c.stdin, c.stdout, c.stderr]) (s as unknown as { unref?: () => void } | null)?.unref?.();
  return c;
}

process.on('exit', () => { try { child?.kill(); } catch { /* already gone */ } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Make sure ComfyUI answers at `url`, starting it over SSH if configured. */
export async function ensureRemoteComfy(url: string, ssh: SshConfig | null, timeoutMs = 240_000): Promise<void> {
  if (await reachable(url)) return;
  if (!ssh) return; // not managed here; the request will report the connection error
  if (!child) child = startSession(ssh);
  const c = child;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(2000);
    if (await reachable(url)) return;
    if (c.exitCode !== null || child !== c) {
      throw new Error(`could not start ComfyUI on ${ssh.target} over SSH: ${recent.slice(-6).join(' | ') || 'ssh exited'}`);
    }
  }
  throw new Error(`ComfyUI on ${ssh.target} did not come up within ${timeoutMs / 1000}s: ${recent.slice(-4).join(' | ')}`);
}

export function remoteSessionState(): string {
  return child ? `SSH session to the GPU PC is open${recent.length ? ` (last: ${recent[recent.length - 1]})` : ''}` : 'no SSH session open (ComfyUI starts on first use)';
}

/** Close the session (stops ComfyUI on the remote PC if this session started it). */
export function stopRemoteComfy(): void {
  child?.kill();
  child = null;
}
