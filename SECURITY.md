# Security policy

Kitsune gives an AI agent control of browser tabs, so security reports matter a lot here.

## What counts

Anything that lets a web page, another local program, or the agent get around Kitsune's safety model, for example:

- acting on a site, frame or tab the user didn't approve, or outside the Kitsune tab group
- pressing, hiding or spoofing the permission window, or approving on the user's behalf
- reading password field values, or uploading files the denylist should block
- disabling or forging Kitsune's hooks (console, dialogs) in a way that misleads the agent or the user
- talking to the helper's socket or named pipe as another user, or impersonating the helper
- the Stop/Pause controls not stopping the agent

Prompt injection (a page containing text that tricks the agent) is a known, general risk of AI agents and is documented in the README. Reports are still welcome when Kitsune could reasonably limit the damage and doesn't.

## How to report

Please **don't open a public issue** for security problems. Instead:

- use GitHub's private reporting: [Report a vulnerability](https://github.com/william-ricchiuti/Kitsune/security/advisories/new), or
- email will.ricchiuti@gmail.com with "Kitsune security" in the subject.

Include the Kitsune version (`npx kitsune-firefox --version` and the version in the toolbar popup), Firefox version, OS, the input mode (synthetic or trusted), and steps to reproduce. You should get a reply within a week. Fixes are released as soon as they're ready, with credit if you'd like it.

## Supported versions

Only the latest release gets security fixes.
