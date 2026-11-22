// Pure derivation of ports, paths and names from a Flavour. No I/O, no printing.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLAVOUR, type Flavour } from './flavour.gen.js';

export interface Identity {
  wsPort: number;
  httpPort: number;
  ipcPath: string;
  home: string;
  statusPath: string;
  logPath: string;
  dumpPath: (ts: number) => string;
  exportsDir: string;
  httpUrl: string;
  figmaSettingsPath: string | undefined;
  homeLabel: string;
  overridesIgnored: string[];
}

export interface IdentityCtx {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  tmp: string;
}

const OVERRIDE_VARS = [
  'GRIP_WS_PORT', 'GRIP_HTTP_PORT', 'GRIP_IPC_PATH', 'GRIP_STATUS_PATH',
  'GRIP_LOG_PATH', 'GRIP_HOME', 'GRIP_FIGMA_SETTINGS',
];

export function makeIdentity(f: Flavour, ctx: IdentityCtx): Identity {
  const { platform } = ctx;
  const honour = !f.lockOverrides || ctx.env.GRIP_TEST === '1';
  const overridesIgnored = honour ? [] : OVERRIDE_VARS.filter((k) => ctx.env[k] !== undefined && ctx.env[k] !== '');
  const env: NodeJS.ProcessEnv = honour ? ctx.env : {};

  const wsPort = Number(env.GRIP_WS_PORT ?? f.wsPort);
  const httpPort = Number(env.GRIP_HTTP_PORT ?? f.httpPort);
  const ipcPath = env.GRIP_IPC_PATH ??
    (platform === 'win32' ? `\\\\.\\pipe\\${f.ipcName}` : join(ctx.tmp, `${f.ipcName}.sock`));
  const home = env.GRIP_HOME || join(ctx.home, f.homeDirName);
  const statusPath = env.GRIP_STATUS_PATH ?? join(ctx.home, `${f.filePrefix}.status`);
  const logPath = env.GRIP_LOG_PATH ?? join(ctx.home, `${f.filePrefix}.log`);

  let figmaSettingsPath: string | undefined;
  if (env.GRIP_FIGMA_SETTINGS) figmaSettingsPath = env.GRIP_FIGMA_SETTINGS;
  else if (platform === 'darwin') figmaSettingsPath = join(ctx.home, 'Library', 'Application Support', 'Figma', 'settings.json');
  else if (platform === 'win32' && ctx.env.APPDATA) figmaSettingsPath = join(ctx.env.APPDATA, 'Figma', 'settings.json');

  return {
    wsPort,
    httpPort,
    ipcPath,
    home,
    statusPath,
    logPath,
    dumpPath: (ts: number) => join(ctx.home, `${f.filePrefix}.dump-${ts}.json`),
    exportsDir: join(ctx.tmp, `${f.slug}-exports`),
    httpUrl: `http://127.0.0.1:${httpPort}/mcp`,
    figmaSettingsPath,
    homeLabel: `~/${f.homeDirName}`,
    overridesIgnored,
  };
}

export const IDENTITY: Identity = makeIdentity(FLAVOUR, {
  env: process.env,
  platform: process.platform,
  home: homedir(),
  tmp: tmpdir(),
});

// Re-derived from the CURRENT environment on every call, for code that has always read
// its env lazily (tests and the installer set GRIP_HOME etc. after import).
export function liveIdentity(): Identity {
  return makeIdentity(FLAVOUR, { env: process.env, platform: process.platform, home: homedir(), tmp: tmpdir() });
}
