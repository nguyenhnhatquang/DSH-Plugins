# DSH-Plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — an agent harness built on [Cordis](https://github.com/cordiverse/cordis) where *everything is a plugin*.

Each package under `packages/` is an independently installable dsh bundle.

## Plugins

| Package | What it does |
|---|---|
| [`dsh-plugin-browserkit`](packages/browserkit/README.md) | Gives agents a real browser to drive and to verify: accessibility snapshots, ref-based interaction, assertions, tabs, dialogs, login persistence, uploads, screenshots, console/network inspection, and CDP attach to an existing browser. One isolated browser per agent. |

## Install

```sh
# into a profile
dsh plugin --profile <profile> add <spec>     # spec: npm name, absolute path, tarball, or git URL

# verify the bundle composed
dsh --profile <profile> --dump-config
dsh --profile <profile> --dump-config-schema
```

The Desktop app owns its `desktop` profile, so the CLI refuses to manage it. Install through the GUI's **Plugins** page, or add a row to `%USERPROFILE%\.dsh\cordis.patch.yml` (the home layer applies to every profile).

## Repository layout

```
packages/<name>/
  package.json        # name, dsh.bundle.patch, dependencies
  cordis.patch.yml    # the bundle's patch layer: which plugin rows it inserts
  lib/                # the plugin entry and its modules (plain ESM, no build step)
  locale/             # display metadata: meta.title, meta.description
  test/               # node:test suites
```

Plugins here ship **plain ESM JavaScript with no build step**. A dsh plugin is a module exporting `name` / `inject` / `Config` / `apply`, and a bundle is a package whose `package.json` declares which patch file inserts its rows. Neither needs a compiler, so a checked-out plugin can be loaded from an absolute path immediately — which is what `scripts/dev-overlay.mjs` does.

## Development

```sh
pnpm install
pnpm test              # every package's node:test suite
pnpm run dev:overlay   # write .dev/overlay.cordis.patch.yml referencing the working tree
```

## Conventions this repo follows

- **Function-plugin contract**: named exports only, **no default export** — a default export makes the Loader discard `inject`.
- **`Config` is a native Schemastery schema**, because the harness introspects it for `--dump-config-schema` and for configuration forms. A plain Standard-Schema object loads but fails the dump.
- **No hardcoded tunables**: anything two deployments might set differently is a validated config field, and an unknown key fails at load instead of silently keeping a default.
- **Registrations are effects**: anything registered through `ctx` unwinds on unload, so resources are released by `ctx.effect(...)` disposers rather than manual teardown.
- **Tool schemas stay inside the harness's JSON-Schema subset** (`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` plus annotations). Each package pins this with a test: `ToolRuntime.register()` rejects the whole plugin entry otherwise, which is a startup failure rather than a runtime one.
- **Tests exercise the real thing.** Fakes substitute for the harness context, not for the external system the plugin drives.

## License

MIT — see each package's `LICENSE`.
