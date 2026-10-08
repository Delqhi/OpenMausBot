# SIN production browser runtime: DSH -> BrowserSkill

This document is the operational browser authority for the SIN/OpenSIN deployment of this fork. It overrides the upstream embedded-browser tiers in `docs/computer-use-integration.md` for production bots configured through the `dsh` ProviderDriver.

## Production contract

- Runtime: **Node 24**.
- OpenMausBot harness: loopback `127.0.0.1:8799`.
- DSH browser service: loopback `127.0.0.1:3080`.
- Browser provider: built-in `DshDriver`, instance id `dsh`, model `dsh-default`.
- OpenMausBot embedded browser authority: `features.browser=false`.
- Real logged-in browser path: `OpenMausBot -> DSH -> BrowserSkill -> Chromium Agent Window`.
- Browser target: `OPENMAUSBOT_DSH_BROWSER=<exact BrowserSkill id-or-label>`; never guess a replacement target.
- DSH owns the browser tool loop. OpenMausBot must not add a bsk subprocess wrapper, browser MCP, raw CDP bridge, Playwright bridge, cookie transfer, or `OPENMAUSBOT_REAL_CHROME` compatibility lane.

## DSH tool boundary

The official BrowserSkill DSH plugin owns six structured groups: `browser_session`, `browser_page`, `browser_inspect`, `browser_interact`, `browser_tabs`, and `browser_assist`. Session start/stop, cancellation, observation state, screenshots, and borrowed-tab cleanup stay inside that plugin. Do not shell out around its schemas.

Version pins and Compatibility Hold decisions live in the companion `wow-my-zsh` repository under `docs/browser-runtime-current.md` plus its runtime JSON configs. OpenMausBot intentionally does not duplicate those version numbers here.

## Runtime configuration

A browser-capable bot uses:

```json
{
  "modelSelection": { "instanceId": "dsh", "model": "dsh-default" },
  "computer": "off"
}
```

The DSH provider config must stay loopback-only, normally `http://127.0.0.1:3080`. `DshDriver.decodeConfig()` rejects non-loopback URLs.

## Acceptance gate

Before declaring production ready:

1. Run `bsk doctor` and confirm the expected Chromium extension/browser is connected.
2. Confirm the OpenMausBot LaunchAgent runs Node 24 from the intended runtime worktree.
3. Confirm `OPENMAUSBOT_DSH_BROWSER` points to a currently connected BrowserSkill browser.
4. Confirm `features.browser=false` and the DSH provider is available.
5. Run a harmless OpenMausBot browser turn. The current turn must use `browser_session(start)` -> bounded structured browser work -> `browser_session(stop)`.
6. While active, `/bsk-observation/state` on the DSH service must show the owned session/thumbnail; afterward it must report zero owned sessions.
7. The final assistant result must be stored in the OpenMausBot thread.
8. Verify no retired Real-Chrome/browser-bridge process or port was reintroduced.

## Native UI

BrowserSkill controls web-page content in its Agent Window. Native browser chrome, macOS dialogs, permissions, or other desktop UI belong to the fleet's native computer-use authority (Orca in the SIN deployment), not to this DSH provider.
