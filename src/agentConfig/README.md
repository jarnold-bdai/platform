# Agent config (`@jarnold-bdai/platform/agentConfig`)

The single definition of the agent-config schema (`AgentConfigZ` and its parts), the publish rules (`checkAgentConfigPublishable`) and the SMS follow-up helpers. Comms (`bdai-mvp-1`) and the UI (`bdai-mvp-ui-1`) each carried a hand-synced copy of these files; this page is how each app switches to the package. Safe for the web app: nothing here imports the AWS SDK.

Four schemas are exported under two spellings, because the apps used different ones. Both spellings are the same object:

| comms (`…Zod`)                  | UI (`…Z`)                     |
|---------------------------------|-------------------------------|
| `ServiceBookingStyleZod`        | `ServiceBookingStyleZ`        |
| `ConsultationProtocolZod`       | `ConsultationProtocolZ`       |
| `MultilingualVersionZod`        | `MultilingualVersionZ`        |
| `CancelOrRescheduleProtocolZod` | `CancelOrRescheduleProtocolZ` |

plus the type `CancelOrRescheduleProtocol`.

Both apps first add the package as a dependency, with the `.npmrc` from the [root README](../../README.md#install-consumers). `zod` stays the app's own dependency (it is a peer).

## Comms (`bdai-mvp-1/layers/shared-types`)

Add `@jarnold-bdai/platform` to `dependencies` in `layers/shared-types/package.json`, not `devDependencies`: the layer build (`Makefile`) runs `npm ci --omit=dev` and must ship it in the layer's `node_modules`. That `npm ci` needs the registry token too.

**The one change that is more than an import path: `src/fieldDefinitions.ts`.** Its three enums move to the package, but the file still uses them (`DEFAULT_SERVICE_BOOKING_STYLE` and the `z.infer` types below), so it imports them and re-exports them:

```ts
import { z } from "zod";
import { ServiceBookingStyleZod, ConsultationProtocolZod, MultilingualVersionZod } from "@jarnold-bdai/platform/agentConfig";

// The agent config's three setting enums are defined once, in the package.
export { ServiceBookingStyleZod, ConsultationProtocolZod, MultilingualVersionZod };
```

and deletes the three `export const ServiceBookingStyleZod = z.enum([...])`, `ConsultationProtocolZod` and `MultilingualVersionZod` definitions. Everything else in the file stays.

This is what avoids the duplicate-export error. `src/index.ts` has `export * from "./fieldDefinitions"` and `export * from "./cancelOrRescheduleProtocol"`, and it will also re-export the package. When two `export *` lines bring the same name from two different declarations, TypeScript reports TS2308, and native ESM refuses the name (`SyntaxError: ... conflicting star exports`). When every path leads to the package's one declaration, both accept it.

Then:

| file | change |
|------|--------|
| `src/cancelOrRescheduleProtocol.ts` | the whole file becomes `export { CancelOrRescheduleProtocolZod, type CancelOrRescheduleProtocol } from "@jarnold-bdai/platform/agentConfig";` |
| `src/agentConfig.ts` | the whole file becomes `export * from "@jarnold-bdai/platform/agentConfig";` |
| `src/agentConfigPublishable.ts` | the whole file becomes `export * from "@jarnold-bdai/platform/agentConfig";` |
| `src/smsFollowUps.ts` | the whole file becomes `export * from "@jarnold-bdai/platform/agentConfig";` |
| `tests/agentConfig.test.ts`, `tests/agentConfigPublishable.test.ts`, `tests/smsFollowUps.test.ts` | delete: the package runs the same tests |

Nothing else changes: `src/index.ts`, every `./agentConfig` / `./fieldDefinitions` / `./cancelOrRescheduleProtocol` import in `src/` and `tests/` (including `tests/agentConfigFixture.ts`, which the other tests use), and the other packages.

Keep `agentConfig.ts` and `smsFollowUps.ts` as one-line files rather than deleting them. Other comms packages import them by path: `thirdPartyIntegrationTools/*` and `bookingPlatformAdapters/*` import `@bdai/shared-types/agentConfig` and `@bdai/shared-types/smsFollowUps`, through their tsconfig `paths`, and in Lambda through the compiled layer. `agentConfigPublishable.ts` has no such importer. You may delete it and the line `export * from "./agentConfigPublishable";` in `src/index.ts` instead; both work.

How this was checked (a one-off in a scratch project that cannot be reproduced from this repo; it is settled for good when comms adopts the shared schema in stage 2): in a scratch project, against the packed package (`npm pack` of this repo), with comms' `layers/shared-types/tsconfig.json` (CommonJS, `moduleResolution: node`, which resolves the subpath through `typesVersions`):

- `tsc` accepts `src/` with these changes, with no TS2308. Without the `fieldDefinitions.ts` change it reports TS2308 for the three enums. Without the `cancelOrRescheduleProtocol.ts` change it reports TS2308 for `CancelOrRescheduleProtocolZod` and `CancelOrRescheduleProtocol`.
- `tests/` type-checks with the same errors as before the change and no new ones.
- A file using comms' `paths` mapping compiles, with imports from `@bdai/shared-types/agentConfig`, `@bdai/shared-types/smsFollowUps`, `@bdai/shared-types/fieldDefinitions` and `@bdai/shared-types`.
- At runtime, compiled to CommonJS and `require`d, and compiled to ESM and `import`ed natively, every one of these names exported by `src/index.ts` is the same object as the package's (`===`): the four enums and the protocol under both spellings, `AgentConfigZ`, `checkAgentConfigPublishable` and `cancellationReminderText`.

## UI (`bdai-mvp-ui-1`)

Add `@jarnold-bdai/platform` to `dependencies` in the root `package.json`. The UI already uses the `…Z` spellings, which the package exports, so the UI only changes import paths.

Delete, in `amplify/functions/shared/aiConfig/`:

- `agentConfig.ts`, `agentConfigPublishable.ts`, `smsFollowUps.ts`
- `agentConfig.test.ts`, `agentConfigPublishable.test.ts`, `smsFollowUps.test.ts` (the package runs the same tests)

Keep `agentConfigTestFixture.ts`, `structuredTypes.ts` and `agentConfigColumns.test.ts`; only their imports change.

In each of these lines, replace the module path with `'@jarnold-bdai/platform/agentConfig'` (the imported names stay as they are):

| file | line(s) | module path today |
|------|---------|-------------------|
| `amplify/functions/shared/aiConfig/agentConfigColumns.ts` | 22 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/agentConfigColumns.test.ts` | 2 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/agentConfigDefaults.ts` | 8 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/agentConfigTestFixture.ts` | 1 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/bootstrapOutcome.ts` | 11 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/configVersions.ts` | 5 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/employeeLimit.ts` | 4, 5 | `./agentConfig`, `./agentConfigPublishable` |
| `amplify/functions/shared/aiConfig/employeeName.ts` | 1 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/legacyConversion.ts` | 5 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/publishCore.ts` | 6, 9 | `./agentConfig`, `./agentConfigPublishable` |
| `amplify/functions/shared/aiConfig/testBeforePublish.ts` | 3 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/voiceCatalogEnv.ts` | 1 | `./agentConfig` |
| `amplify/functions/shared/aiConfig/voiceOptions.ts` | 1 | `./agentConfig` |
| `amplify/functions/shared/business/commsBusiness.ts` | 3 | `../aiConfig/agentConfig` |
| `amplify/functions/shared/integrations/squareConnectionChange.ts` | 2 | `../aiConfig/agentConfig` |
| `amplify/functions/bootstrapReconciler/src/reconcileBootstraps.ts` | 19 | `../../shared/aiConfig/agentConfig` |
| `amplify/functions/getVoiceCatalog/handler.ts` | 7 | `../shared/aiConfig/agentConfig` |
| `amplify/functions/handleEventsFromOtherServices/src/bootstrapJobStatusHandler.ts` | 5 | `../../shared/aiConfig/agentConfig` |
| `amplify/functions/handleEventsFromOtherServices/src/legacyConversionJobStatusHandler.ts` | 12 | `../../shared/aiConfig/agentConfig` |
| `amplify/functions/handleEventsFromOtherServices/__tests__/bootstrapJobStatusHandler.test.ts` | 2 | `../../shared/aiConfig/agentConfig` |
| `amplify/functions/handleEventsFromOtherServices/__tests__/legacyConversionJobStatusHandler.test.ts` | 2 | `../../shared/aiConfig/agentConfig` |
| `amplify/functions/syncAiConfigFromBackend/liveContent.ts` | 3 | `../shared/aiConfig/agentConfig` |
| `amplify/functions/updateAgentConfigDraft/handler.ts` | 15 | `../shared/aiConfig/agentConfig` |
| `amplify/functions/updateAgentConfigDraft/handler.test.ts` | 3 | `../shared/aiConfig/agentConfig` |
| `scripts/migrations/aiConfigRekeyAndColumnsPlan.ts` | 33 | `../../amplify/functions/shared/aiConfig/agentConfig` |
| `scripts/migrations/seedVoiceSettings.ts` | 77 | `../../amplify/functions/shared/aiConfig/agentConfig` |
| `scripts/migrations/seedVoiceSettingsPlan.ts` | 37 | `../../amplify/functions/shared/aiConfig/agentConfig` |
| `scripts/migrations/seedVoiceSettingsPlan.test.ts` | 7 | `../../amplify/functions/shared/aiConfig/agentConfig` |
| `web/src/types/aiConfig.ts` | 71, 78, 105, 110, 119, 128 | `@amplify/functions/shared/aiConfig/agentConfig` |
| `web/src/types/aiConfig.ts` | 111 | `@amplify/functions/shared/aiConfig/smsFollowUps` |
| `web/src/types/aiConfig.ts` | 136, 137 | `@amplify/functions/shared/aiConfig/agentConfigPublishable` |

(The line numbers are those of the UI repo at the time of writing; `git grep -nE "aiConfig/(agentConfig|agentConfigPublishable|smsFollowUps)'|\./(agentConfig|agentConfigPublishable|smsFollowUps)'"` lists them again.)

How this was checked: every name the UI's three files export is exported by the package. `amplify/functions/shared` was type-checked with `moduleResolution: bundler` against the packed package, before and after the change. The change added no error; the remaining errors come from the UI's own dependencies, which were not installed. `web/` and `scripts/` were not compiled: they make the same change of module path.
