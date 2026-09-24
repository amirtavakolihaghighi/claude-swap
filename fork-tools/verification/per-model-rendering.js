/**
 * Integration check: does a per-model (`scoped`) window actually reach the status
 * bar, the tooltip, the sidebar tree AND a notification?
 *
 * The pure logic is unit-tested in analysis.test.ts, but the WIRING cannot be
 * exercised on a machine whose accounts report no per-model windows — and neither
 * account on the development machine does, so this path had never executed end to
 * end. This drives the REAL StatusBar / AccountsTreeProvider / Notices classes, not
 * reimplementations of them.
 *
 * The payload shape is not invented. It is upstream's own API test fixture
 * (tests/test_oauth.py, "weekly_scoped entries in limits[] surface as
 * result['scoped'] by model name"), which encodes an observed live response: the
 * account's weekly window at 72% while the per-model Fable window is at 100%. That
 * 28-point gap is the blind spot the warning exists for.
 *
 * Measured 2026-09-24: 10 assertions, all passing.
 *
 * Requires a compiled extension:  cd vscode-extension && npm run compile
 *
 * Run from anywhere:
 *     node fork-tools/verification/per-model-rendering.js
 * Exit code 0 = the model surfaces everywhere it should, 1 = it does not.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const EXT = path.join(REPO, 'vscode-extension');

let statusBarState = {};
let treeProvider = null;
const notifications = [];

const settings = {
  executablePath: '', refreshIntervalSeconds: 60,
  'autoSwitch.enabled': false, 'autoSwitch.intervalSeconds': 60, 'autoSwitch.notify': true,
  'statusBar.showAllAccounts': false,   // single-account view, so the model flag is visible
  notifyOnReset: true, warnLoginExpiryDays: 3, showPaceWarnings: true,
};

const vscodeStub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ConfigurationTarget: { Global: 1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  MarkdownString: class {
    constructor() { this.value = ''; }
    appendMarkdown(s) { this.value += s; return this; }
  },
  Uri: { file: (p) => ({ fsPath: p }) },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({
      show: () => {}, dispose: () => {},
      set text(v) { statusBarState.text = v; }, get text() { return statusBarState.text; },
      set tooltip(v) { statusBarState.tooltip = v; }, get tooltip() { return statusBarState.tooltip; },
      set backgroundColor(v) { statusBarState.bg = v ? v.id : undefined; },
      get backgroundColor() { return statusBarState.bg; },
      set command(v) {}, set name(v) {},
    }),
    showInformationMessage: (m) => { notifications.push(['info', m]); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { notifications.push(['warn', m]); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { notifications.push(['error', m]); return Promise.resolve(undefined); },
    createTerminal: () => ({ show: () => {} }),
    showQuickPick: () => Promise.resolve(undefined),
    registerTreeDataProvider: (id, p) => { treeProvider = p; return { dispose: () => {} }; },
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve(),
  },
  workspace: {
    workspaceFolders: [], isTrusted: true,
    getConfiguration: () => ({ get: (k) => settings[k], update: () => Promise.resolve() }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
};

// The payload under test. Shape from upstream tests/test_oauth.py: the weekly_scoped
// limit reaches 100% while the account-level weekly window sits at 72%.
const PAYLOAD = {
  schemaVersion: 1,
  activeAccountNumber: 2,
  accounts: [
    {
      number: 2, email: 'you@example.com', organizationUuid: 'org-2', active: true,
      usageStatus: 'ok',
      usage: {
        fiveHour: { pct: 7, resetsAt: '2026-03-23T15:00:00+00:00', countdown: '3h 0m' },
        sevenDay: { pct: 72, resetsAt: '2026-03-27T00:00:00+00:00', countdown: '3d 12h' },
        scoped: [{
          pct: 100, name: 'Fable',
          resetsAt: '2026-03-23T15:00:00+00:00', countdown: '3h 0m',
        }],
      },
      usageFetchedAt: new Date().toISOString(), usageAgeSeconds: 0,
    },
  ],
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.apply(this, arguments);
};

// Replace the cswap bridge with one that serves PAYLOAD, so no real CLI runs.
const cswapPath = require.resolve(path.join(EXT, 'out', 'cswap.js'));
require.cache[cswapPath] = {
  id: cswapPath, filename: cswapPath, loaded: true, exports: {
    list: () => Promise.resolve(PAYLOAD),
    status: () => Promise.resolve({ schemaVersion: 1, active: null }),
    autoSwitchThreshold: () => Promise.resolve(90),
    autoOnce: () => Promise.resolve({ code: 2, events: [] }),
    resolveExecutable: () => 'cswap',
    resetExecutableCache: () => {},
    switchTo: () => Promise.resolve({}),
    switchBest: () => Promise.resolve({}),
    mapDirectory: () => Promise.resolve(''),
    CswapError: class extends Error {},
    CswapNotFoundError: class extends Error {},
  },
};

const context = {
  subscriptions: [],
  globalState: { get: () => undefined, update: () => Promise.resolve() },
  globalStorageUri: { fsPath: path.join(__dirname, 'gs') },
};

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition && detail) console.log(`        got: ${detail}`);
  return condition ? 0 : 1;
}

(async () => {
  const entry = path.join(EXT, 'out', 'extension.js');
  if (!fs.existsSync(entry)) {
    console.error(`Not compiled: ${entry}
Run: cd vscode-extension && npm run compile`);
    process.exit(1);
  }
  const ext = require(entry);
  ext.activate(context);
  await new Promise((r) => setTimeout(r, 1200));

  console.log('=== STATUS BAR ===');
  console.log(`  text: ${statusBarState.text}`);
  console.log(`  background: ${statusBarState.bg}`);
  console.log('');

  const tooltip = statusBarState.tooltip?.value ?? '';
  console.log('=== TOOLTIP (model lines) ===');
  tooltip.split('\n').filter((l) => /Fable|real limit|autoswitch\.model/.test(l))
    .forEach((l) => console.log(`  ${l.trim()}`));
  console.log('');

  console.log('=== SIDEBAR TREE ===');
  const rows = [];
  for (const root of treeProvider.getChildren()) {
    const ri = treeProvider.getTreeItem(root);
    console.log(`  ${ri.label}  ${ri.description ?? ''}`);
    for (const c of treeProvider.getChildren(root)) {
      const ci = treeProvider.getTreeItem(c);
      rows.push(ci);
      console.log(`      ${String(ci.label).padEnd(8)} ${ci.description ?? ''}`
        + (ci.iconPath?.id ? `   [${ci.iconPath.id}]` : ''));
    }
  }
  console.log('');

  console.log('=== NOTIFICATIONS ===');
  notifications.forEach(([k, m]) => console.log(`  [${k}] ${m}`));
  console.log('');

  console.log('=== ASSERTIONS ===');
  let bad = 0;
  bad += check('status bar names the model and its percentage',
    /Fable/.test(statusBarState.text) && /100%/.test(statusBarState.text), statusBarState.text);
  bad += check('status bar goes red (the model window is past 90)',
    statusBarState.bg === 'statusBarItem.errorBackground', String(statusBarState.bg));
  bad += check('status bar still reports the account window as binding (7d 72%)',
    /7d 72%/.test(statusBarState.text), statusBarState.text);
  bad += check('tooltip marks the model row as the real limit',
    /real limit/.test(tooltip));
  bad += check('tooltip gives the exact fix command with the model name',
    /cswap config set autoswitch\.model Fable/.test(tooltip));
  const fableRow = rows.find((r) => r.label === 'Fable');
  bad += check('tree has a Fable row', !!fableRow);
  bad += check('tree flags that row with a warning icon',
    fableRow?.iconPath?.id === 'warning', fableRow?.iconPath?.id);
  bad += check('tree row explains why it matters',
    /further along/.test(fableRow?.tooltip ?? ''), fableRow?.tooltip);
  const warn = notifications.find(([k, m]) => k === 'warn' && /Fable/.test(m));
  bad += check('a warning notification fires naming the model', !!warn);
  bad += check('notification states the model limit is what stops you first',
    /stop you first/.test(warn?.[1] ?? ''), warn?.[1]);

  console.log('');
  console.log(bad === 0 ? `ALL ${10} ASSERTIONS PASSED` : `${bad} ASSERTION(S) FAILED`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(1);
});
