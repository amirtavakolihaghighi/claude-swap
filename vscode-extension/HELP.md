# Claude Swap — Help

Everything Claude Swap shows and does, in plain words. Each action is described the
same way: **what it does**, **what you will see**, and **good to know**, which lists
anything risky or with a lasting effect.

**Contents**

- [Words used here](#words-used-here)
- [The status bar](#the-status-bar)
- [The sidebar: Accounts](#the-sidebar-accounts)
- [The sidebar: Windows](#the-sidebar-windows)
- [Everyday actions](#everyday-actions)
- [Separate folder logins](#separate-folder-logins)
- [Messages you may see](#messages-you-may-see)
- [Settings](#settings)
- [When something seems wrong](#when-something-seems-wrong)

---

## Words used here

- **Account**: one Claude subscription (an email address). Claude Swap numbers
  them: #1, #2, …
- **The main login**: the account Claude is signed in to on this computer. Every
  Claude tab in every window uses it, unless its folder has a separate login.
  Switching changes the main login, and all those tabs follow on their next message.
- **Saved login**: the copy of an account's login that Claude Swap keeps, so it can
  switch to that account without you signing in.
- **Separate folder login**: a login that belongs to one folder. Claude tabs in that
  folder use it and do not follow the main login. See
  [Separate folder logins](#separate-folder-logins).
- **Usage**: how much of an account's limits is used. The **5-hour** window refills
  a few hours after use; the **weekly** window is the larger budget. Some plans
  also have a weekly limit per model.
- **Why logins end**: every Claude login lasts about 30 days, a rule Anthropic sets.
  Then Claude asks you to sign in again. A login also ends early if you sign out,
  or if two copies of the same login exist and one of them renews.

---

## The status bar

The item on the right of the status bar shows each account's usage, for example
`#2 58% | #1 61%`. With more than four accounts it shows only the active one.

- **Amber** from 75% and **red** from 90%.
- **Click it** to switch accounts.
- **Hover over it** for the full picture: every account's 5-hour, weekly and
  per-model usage, when each resets, warnings, which login Claude uses in this
  window, and links: Switch account, Most quota, Refresh, Save login, auto-switch
  on/off, Logs, Help.

---

## The sidebar: Accounts

Click the Claude Swap icon in the activity bar (the left edge of VS Code).

- **One row per account**, with a usage bar for its fullest window. The active
  account (the main login) is marked. Hover for details.
- **Expand a row** to see each window (5-hour, weekly, per-model), how fast it is
  being used, warnings, and how many days its saved login has left.
- **The arrows button** on a row switches to that account.
- **Buttons at the top**: Refresh, Switch to the account with the most quota, Save
  current login (key icon), Help (question mark). The **…** menu has *How fast am I
  using quota?*, auto-switch on/off, and *Clear usage history*.

---

## The sidebar: Windows

Below Accounts. It lists **every open VS Code window**, this one first, and is the
same in every window.

For each window:

- **Which login its Claude tabs use**: the main login (and which account that is
  now), or the folder's own login.
- **For a folder with its own login**: whether it is signed in, as whom, and how many
  days the login has left. If it signed in with the wrong account, it says so.
- **How many Claude tabs are running there** (only while separate folder logins
  are on, because the launcher is what counts them).
- **Go to this window** brings that window to the front.
- **For this window**: *Use a separate login in this folder…* or *Stop using the
  separate login here…*.

**Buttons at the top**: turn separate folder logins on, set up this folder,
refresh, help. The **…** menu has *Stop using the separate login here* and *Turn off
separate folder logins*.

A window appears here a few seconds after it opens, and disappears within about two
minutes of closing.

---

## Everyday actions

### Switch Account…

- **What it does**: changes the main login to the account you pick.
- **What you will see**: a list of accounts with their usage, then *"Switched to
  Account-N. It's active now — your next message in any Claude tab uses it."*
- **Good to know**: every window on the main login follows on its next message. No
  reload is needed. Folders with their own login are not affected. The first message
  after a switch uses a little more of the new account's quota, because the new
  account reads the conversation from scratch.

### Switch to Account With Most Quota

- **What it does**: the same as Switch Account, choosing the account with the most
  room for you.
- **What you will see**: the same message as above.

### Refresh Usage Now

- **What it does**: asks cswap for the latest numbers.
- **What you will see**: *"Checking usage…"* in the status bar, then a message such as
  *"#2 (active) was checked just now. #1 was checked 4m ago."* If a check failed, it
  says why in plain words and when it will try again.
- **Good to know**: Refresh cannot force new numbers. Anthropic allows only about 30
  usage checks an hour per account, so cswap spaces its checks out, and waits longer
  after Anthropic says there were too many. Another extension that checks Claude
  usage for the same account uses up the same allowance.

### Save Current Login

- **What it does**: stores the login Claude is signed in with in Claude Swap. For an
  account it already knows, the saved copy is updated. For a new account, the
  account is added.
- **What you will see**: for a new account, first *"Add you@… to Claude Swap?"*. Then
  *"Saved the current login for #N"* or *"Added you@… as account #N."*
- **When to use it**: after you sign in to Claude again (a login lasts about 30 days),
  or to add a new account. Claude Swap also offers it by itself when it notices such a
  sign-in.
- **Good to know**: it replaces that account's previously saved login. That is the
  point: the old one no longer works. It refuses a login that does not match the
  signed-in account.

### Rescue — Switch Account and Reload Window

- **What it does**: switches to the account with the most quota and reloads this
  window, for when a limit has just cut you off.
- **What you will see**: a confirmation, then the window reloads. Claude tabs come
  back and carry on.
- **Good to know**: the reload restarts everything in this window, including any
  Claude reply in progress.

### Toggle Background Auto-Switch

- **What it does**: when on, Claude Swap checks regularly and switches the main login
  before the active account hits its limit.
- **What you will see**: a confirmation when turning on, then a notification after
  each automatic switch.
- **Good to know**: switches then happen without a click, and move every window on
  the main login. Only one window runs the check, however many are open.

### How Fast Am I Using Quota?

- **What it does**: estimates how quickly each account's 5-hour window is being used,
  from readings recorded on this computer.
- **What you will see**: for example *"burning ~9%/h · about 2h 40m of headroom"*, or
  *"not enough history yet"* during the first hour.

### Clear Usage History

- **What it does**: deletes the readings behind the speed estimates.
- **Good to know**: it cannot be undone, and asks first. Accounts, logins and limits
  are not touched.

### Show Logs

- **What it does**: opens Claude Swap's log, which records every command it ran and
  every error, with details.

### Open Full Dashboard in Terminal

- **What it does**: opens cswap's own full-screen dashboard in a VS Code terminal.

### Bind Folder for Terminal Sessions (cswap run)

- **What it does**: tells cswap which account `cswap run` should use in a folder.
  It **only affects Claude started from a terminal with `cswap run`**, not Claude tabs.
  For Claude tabs, use [separate folder logins](#separate-folder-logins).

### Help

- **What it does**: opens this page.

---

## Separate folder logins

Claude tabs in a folder you choose use **their own login** for an account, while
every other window keeps the main login. For example, a work project can always run
on the work account, while everything else runs on your personal one and follows the
main login when you switch.

### How it works

Anthropic's Claude extension can start Claude through a program you name. Claude
Swap builds a small **launcher**, using a compiler that is part of Windows, and names
it there. Every time Claude starts, the launcher checks the folder:

- **a folder you set up**: Claude gets that folder's own login
- **any other folder**: nothing changes

The folder's login is a **separate sign-in**, not a copy of Claude Swap's saved one.
That is why the same account can be used by the main login and by a folder at the
same time: each holds its own login, so neither breaks the other.

### Turn On Separate Folder Logins

- **What it does**: builds the launcher and sets Anthropic's setting *Claude Code ›
  Claude Process Wrapper* to it.
- **What you will see**: a confirmation that lists everything below, a short
  "building the launcher" progress message, then an offer to set up the current
  folder.
- **Good to know**:
  - It changes one Claude extension setting, for all windows.
  - Claude tabs already open keep running as they are. New tabs start through the
    launcher.
  - With a launcher set, the Claude extension also lists sessions started by scripts
    and tools in its history, and skips a background check it runs after updating
    itself.
  - Windows only, for now.

### Use a Separate Login in This Folder…

- **What it does**: gives this window's folder, and its subfolders, its own login for
  the account you pick.
- **What you will see**: a list of your accounts, plus *"Another account"* for one
  that is not in Claude Swap. Then a confirmation. Then: open a new Claude tab in
  this window, and Claude shows its sign-in screen. Sign in as that account in the
  browser, once.
- **Shared with your other windows**: conversations, Claude's notes about the
  project, settings and hooks, CLAUDE.md and MCP servers.
- **Kept separate**: the login itself, and the skills and plugins claude.ai syncs to
  each account.
- **Good to know**:
  - Claude tabs already open in this window keep their current login until you close
    them. Reloading the window restarts them all; they come back where they were.
  - Two folders set to the same account share one separate login, so you sign in
    once.
  - Other windows, and the main login, can use the same account at the same time.
    They share its usage limits.
  - The login lasts about 30 days. Then Claude in that folder asks you to sign in
    again, there. Claude Swap warns you a few days before.
  - A setting you change inside the folder is replaced when your main settings
    change.

### Stop Using the Separate Login in This Folder…

- **What it does**: new Claude tabs in the folder use the main login again.
- **What you will see**: a confirmation with two choices: keep the separate login
  (setting the folder up again then needs no sign-in), or delete it.
- **Good to know**: conversations are not affected either way. Open Claude tabs keep
  their login until closed. A login used by another folder, or by a running Claude
  tab, cannot be deleted.

### Turn Off Separate Folder Logins

- **What it does**: clears Anthropic's setting, so Claude starts directly again and
  every folder uses the main login.
- **What you will see**: a confirmation. *"Turn off"* keeps your folder settings and
  separate logins, so turning on again restores them. *"Turn off and forget"* deletes
  them.

### If you uninstall Claude Swap

Turn separate folder logins off first. If you forget, Claude keeps working, because
the launcher stays behind on its own. To remove it, clear *Claude Code › Claude
Process Wrapper* in VS Code Settings.

### Where it keeps things

`%LOCALAPPDATA%\ClaudeSwapVSCode` holds:

- the launcher, and its own log, `launcher.log`
- the folder list
- one login folder per account (`logins\…`)
- small records through which windows see each other

---

## Messages you may see

| Message | What it means | What to do |
| --- | --- | --- |
| *Switched to Account-N. It's active now…* | The switch is done. | Nothing. |
| *#2 (active) was checked 4m ago…* | Refresh found no newer reading yet. | Nothing; new numbers come on their own. |
| *…no new numbers: a network problem reaching Anthropic* | The check could not reach Anthropic. | Check the connection (VPN, proxy). It retries by itself. |
| *…too many usage checks, so Anthropic asked to wait* | The account's ~30 checks an hour are used up. | Wait. Another usage extension may be using the same allowance. |
| *You signed in to account #N again. Save the new login…?* | Claude has a newer login than Claude Swap's saved one. | Click **Save login**. |
| *Claude Code is signed in as …, which Claude Swap doesn't know yet* | You signed in with a new account. | Click **Add account** if you want to switch to it later. |
| *Account #N's login expires in 3 days* | That login is about to end. | When it does, sign in again as that account; Claude Swap then offers to save it. |
| *"Folder" is set to use A, but its Claude tab signed in as B* | The folder signed in with the wrong account. | In a Claude tab in that window: sign out, then sign in as A. |
| *Claude cannot start in any window, because the launcher … is missing* | The launcher was deleted and could not be rebuilt. | Click **Turn off separate folder logins**. |

---

## Settings

Open them with *File › Preferences › Settings* and search for **Claude Swap**. Each
setting's description there says what it does.

- **Executable path**: where the `cswap` program is. Empty means Claude Swap finds it
  itself.
- **Refresh interval**: how often the status bar re-reads usage. A lower value does
  not give fresher numbers.
- **Auto-switch: enabled / interval / notify**: background auto-switching. See
  [Toggle Background Auto-Switch](#toggle-background-auto-switch).
- **Warn login expiry days**: how many days before a login ends you are warned. `0`
  turns it off.
- **Show pace warnings**: warn when an account is on course to run out of its weekly
  quota early.
- **Status bar: show all accounts**: every account in the status bar, or just the
  active one.
- **Notify on reset**: tell you when every account is spent, and when one has room
  again.

---

## When something seems wrong

- **Refresh does nothing.** See [Refresh Usage Now](#refresh-usage-now): readings are
  rationed, and the message after a click says how old they are.
- **You are asked to sign in again unexpectedly.** Logins last about 30 days. Another
  tool that renews Claude logins by itself can also break one, if it renews at the
  same moment as Claude or during a switch. After signing in again, use **Save current
  login**.
- **Claude does not start after turning on separate folder logins.** Turn them off
  (Windows view, … menu), then use *Show Logs*. The launcher's own log is
  `%LOCALAPPDATA%\ClaudeSwapVSCode\launcher.log`.
- **A folder uses the wrong account.** The Windows view says which account it signed
  in as. In a Claude tab there, sign out, then sign in with the right one.
- **Anything else.** *Show Logs* records every command and every error.
