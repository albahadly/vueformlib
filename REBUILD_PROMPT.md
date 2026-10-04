# Prompt: Rebuild "Vueform" as a modern Form Builder + portable Form Runtime

> Paste everything below the line into a fresh Claude Code session, in an empty repository.
> It is written in phases. Run it phase by phase ("Do Phase 0", "Do Phase 1", …) and
> review each phase before continuing. Each phase ends with a working, tested, committed state.

---

## Role

You are the lead engineer rebuilding a form framework from scratch. The old system
(`@vueform/vueform` 1.13, ~35k lines of JS, Vue 2+3 dual build) works but is hard to
maintain: 1,700-line composables, a hand-written 11,000-line `index.d.ts`, runtime
Proxy-based class merging, 1 MB unminified bundles, shared config objects mutated at
runtime, and components that leak watchers/listeners on unmount. The drag-and-drop
builder was a separate paid product, so a user could never own the whole pipeline
(design a form → export it → run it anywhere).

Build the replacement as **three products that share one contract**:

1. **Form Schema** — a versioned JSON document that fully describes a form. This is the
   portable artefact. It is framework-agnostic and the only thing the builder exports.
2. **Form Runtime** — renders and runs a schema: state, validation, conditions,
   expressions, steps, i18n, submission. A framework-agnostic core plus a Vue 3 renderer.
3. **Form Builder** — a drag-and-drop web app that produces a schema and exports it in
   several formats that work in any new project with zero build-step coupling.

Prioritise: correctness → portability → developer experience → bundle size → feature
breadth. Ship a small, solid vertical slice first; add elements afterwards.

## Non-negotiable technical decisions

- **TypeScript everywhere**, `strict: true`. Types are *derived* from schema definitions
  (Zod), never hand-maintained in parallel.
- **Vue 3 only** (`<script setup>`, Composition API). No Vue 2 build. No Options API.
- **pnpm workspace monorepo**, Vite for builds, Vitest for unit tests, Playwright for
  builder/renderer e2e, Turborepo (or plain pnpm `-r`) for task orchestration.
- **Core has zero UI dependencies.** `@formkit-x/core` (pick a real scope name once and
  stick to it) must run in Node so the *same* schema validates on the server.
- **No lodash, no moment, no axios.** Use native ES, `Temporal`-polyfill or `date-fns`,
  and `fetch`. Keep runtime deps to a minimum and justify each one in `DECISIONS.md`.
- **Safe expression evaluation.** Never `eval`/`new Function`/`expr-eval` (unmaintained,
  known RCE). Write a small tokenizer + recursive-descent parser + evaluator with a
  whitelisted function table. Property access must use a path resolver that handles
  multi-digit list indexes (`items.12.price`) and wildcards (`items.*.price`).
- **Immutable config.** Global config, theme objects and endpoint definitions are deep-
  frozen after install. Per-element overrides are computed copies, never in-place edits.
- **Every side effect has a teardown.** Watchers, DOM listeners, timers, `ObjectURL`s,
  third-party widgets (Sortable, signature pad, autocomplete) are released in
  `onScopeDispose`/`onBeforeUnmount`. Add a test that mounts/unmounts 100× and asserts
  no growth in active effects.
- **Styling via static class maps + CSS variables**, resolved at build/setup time, not a
  runtime Proxy. Tailwind-compatible out of the box; theming by overriding a typed `ui`
  object and CSS variables. Headless mode (`unstyled: true`) ships no classes.
- **Accessibility is a feature, not a theme.** Every element: label association, `aria-
  describedby` for description/error, `aria-invalid`, keyboard operability, focus
  management on step change and on first invalid field. Axe checks in e2e tests.
- **Bundle budget:** `@…/vue` core renderer ≤ 60 kB min+gzip with the 8 basic elements;
  heavy elements (rich text, signature, location, phone, date picker, slider) are
  separate entry points / packages and lazy-loadable from the schema.
- Tests are written **with** each feature, not after. Regression tests for every bug in
  the "Lessons from v1" list below.

## Repository layout

```
packages/
  schema/      Zod schema definitions, JSON-Schema export, migrations, TS types
  core/        engine: FormInstance, state tree, validation, conditions, expressions,
               i18n, submission, data transforms  (no DOM, no Vue)
  vue/         Vue 3 renderer: <FormRenderer>, <FormBuilderEmbed>, element components,
               composables that wrap core, themes, class maps
  elements-rich/   EditorElement (TipTap), SignatureElement, LocationElement,
               PhoneElement, SliderElement, DateElement (Vue, lazy-loaded)
  server/      Node validation of a schema + payload (framework-agnostic function,
               plus thin adapters for Express/Hono/Nuxt server routes)
  web-component/  <form-runtime schema="…" schema-url="…"> via defineCustomElement
apps/
  builder/     the drag-and-drop builder (Vue 3 + Pinia + @vueuse + vuedraggable or
               dnd-kit-vue), deployable as static site
  docs/        VitePress docs, every element gets a live example
  playground/  minimal Vite app consuming the renderer from the workspace
examples/
  vite-vue/    "use the exported form in a brand-new project" — must work from the
               published packages, not workspace links
  nuxt/
  plain-html/  uses the web component from a CDN script tag
```

## The Schema (package `schema`) — define this first, everything else depends on it

```ts
interface FormSchema {
  $schema: 'https://<your-domain>/form-schema/v1'
  version: 1
  id: string                 // stable uuid
  meta: { name: string; createdAt: string; updatedAt: string; builderVersion: string }
  settings: {
    locale: string; fallbackLocale: string; languages?: string[]   // multilingual
    submit: { endpoint?: string; method?: 'POST'|'PUT'|'PATCH'|'GET'; headers?: Record<string,string>;
              formData?: boolean; successMessage?: LocalizedText; redirect?: string }
    validateOn: 'change' | 'blur' | 'submit' | 'step'
    layout: { columns: 12; gap: string; size: 'sm'|'md'|'lg'; floatLabels: boolean }
    theme?: string
  }
  steps?: Step[]             // optional multi-step; each lists element ids
  tabs?: Tab[]
  elements: Element[]        // ORDERED array (not object) — order is explicit
  translations?: Record<locale, Record<key, string>>   // for LocalizedText refs
}

type LocalizedText = string | { [locale: string]: string }

interface BaseElement {
  id: string                 // stable, builder-generated
  name: string               // data key (path segment)
  type: ElementType
  label?: LocalizedText; description?: LocalizedText; info?: LocalizedText
  placeholder?: LocalizedText
  default?: unknown
  rules?: Rule[]             // typed objects, NOT 'required|min:3' strings
  conditions?: Condition     // see below
  columns?: ResponsiveColumns
  disabled?: boolean | Condition; readonly?: boolean | Condition
  submit?: boolean           // include in payload (default true)
  expression?: string        // computed value
  ui?: { classes?: Record<string,string>; view?: string }   // typed per element
  attrs?: Record<string, string | number | boolean>
}

type Rule =
  | { rule: 'required' } | { rule: 'min'; value: number } | { rule: 'regex'; pattern: string; flags?: string }
  | { rule: 'unique'; endpoint: string } | … // one discriminated union member per rule
  & { message?: LocalizedText; when?: Condition }   // conditional rules

type Condition =
  | { field: string; op: Operator; value?: unknown }         // leaf; field may contain '*'
  | { and: Condition[] } | { or: Condition[] } | { not: Condition }
  | { expr: string }                                          // '{age} >= 18'
type Operator = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not_in' | 'empty' | 'not_empty'
              | 'between' | 'starts_with' | 'ends_with' | 'contains' | 'before' | 'after' | 'today'
```

Requirements for `schema`:

- Zod definitions are the single source of truth; export `type FormSchema = z.infer<…>`,
  a JSON-Schema file (for editors/other languages), and `validateSchema()`.
- `migrate(schema)` upgrades older `version`s. Write the migration framework now even
  though only v1 exists.
- Provide `importLegacyVueform(schemaObject)` that converts the old Vueform object
  schema (object keyed by name, string rules like `'required|min:3'`, array conditions
  like `[['age','>=',18]]`, `[[...],[...]]` for OR) into the new schema, so existing
  forms can be migrated. Cover it with fixture-based tests.
- Container elements (`object`, `group`, `list`, `grid`, `matrix`) hold `children:
  Element[]`; `list` holds `item: Element` (the repeated template).

## Element catalogue (parity target with v1, in delivery order)

Phase-1 basics (in `vue`): `text`, `textarea`, `number`, `email/url/password` (text
variants), `select`, `multiselect`, `radio-group`, `checkbox`, `checkbox-group`,
`toggle`, `hidden`, `static` (markdown/HTML, sanitized once at schema load), `button`.
Phase-2 structure: `object`, `group`, `list` (repeatable, sortable), `grid`, `matrix`,
`address` (preset composed from basics), `steps`, `tabs`.
Phase-3 rich (in `elements-rich`, lazy): `date`, `dates`/range, `time`, `file`,
`multifile` (temp-upload flow with abort), `editor` (TipTap), `signature`, `slider`,
`phone` (country code), `location` (Google/Algolia/Nominatim provider interface),
`tags`, `captcha` (provider interface: reCAPTCHA v2/v3, Turnstile, hCaptcha).
Multilingual inputs are **not separate element types**: any input gets `multilingual:
true` and stores `{ [locale]: value }`.

## Core engine (package `core`)

- `createForm(schema, { initialData, locale, services })` → `FormInstance` with a
  reactive-agnostic store (use a tiny signals implementation or `@vue/reactivity`
  — it works outside components; decide and document). Expose `subscribe()`.
- State tree per element: `value`, `dirty`, `touched`, `validated`, `pending`, `errors`,
  `visible` (conditions), `disabled`, `readonly`. Paths like `items.3.price`.
- Validation: the full v1 rule list (accepted, active_url, after, after_or_equal, alpha,
  alpha_dash, alpha_num, array, before, before_or_equal, between, boolean, captcha,
  completed, confirmed, date, date_equals, date_format, different, digits,
  digits_between, dimensions, distinct, email, exists, file, filled, gt, gte, image, in,
  in_array, integer, ip, ipv4, ipv6, json, lt, lte, max, mimes, mimetypes, min, not_in,
  not_regex, nullable, numeric, regex, required, same, size, string, timezone, unique,
  url, uuid). Each rule is a pure function `(value, params, ctx) => boolean |
  Promise<boolean>`; async rules are debounced per element with **request sequencing**
  (latest wins, stale results dropped) and always settle `pending`. Rule dependencies
  (`same`, `different`, `confirmed`, `distinct`, conditional `when`) are declared so the
  engine knows what to re-validate — no deep watchers.
- Conditions: evaluate the `Condition` tree; `strict` mode treats `null`/`''` as failing
  every comparison operator (including `>`). Dependencies are extracted statically so
  only affected elements re-evaluate.
- Expressions: `{ … }` interpolation with the parser described above. Built-in
  functions: NOT, EMPTY, NOT_EMPTY, SUM, AVG, MIN, MAX, ROUND, COUNT, AGE, TODAY, NOW,
  DATE_ADD, FORMAT_DATE, IF, CONCAT, LEN. Decimal-safe (`SUM(1.5, 2.5) === 4`).
  Self-reference is an error. Cache parsed ASTs per expression string.
- i18n: `t(key | LocalizedText, params)` with fallback chain, parameter interpolation
  that does not misinterpret `$&`-style sequences, locale packs ported from v1's 31
  languages (`locales/*`) as JSON.
- Submission: `submit()` → validate → `prepare` hooks → build payload (JSON by default,
  `FormData` when any file present or `formData: true`; `null`/`undefined` → omitted,
  never the string `"undefined"`) → `fetch` with `AbortController` → typed result
  `{ ok, status, data, errors }`; server-side field errors (`{ errors: { 'items.0.price':
  ['…'] } }`) map back onto elements.
- `toJSON()` / `load(data)` with per-element `formatLoad`/`formatData` hooks.

## Vue renderer (package `vue`)

- `<FormRenderer :schema :model-value :locale :theme @submit @change>` — the only
  component a consuming app needs. `v-model` is the data object.
- Elements register through `defineElement({ type, component, schema: ZodObject,
  defaults, builder: { icon, category, inspectorFields } })` — **one definition powers
  the renderer, the type system and the builder inspector**.
- Slots for every text region; `<template #element-text="{ el }">` to override an
  element wholesale.
- Themes: `default` (CSS variables), `tailwind` (class map), `unstyled`. A theme is a
  typed object `{ [elementType]: { [slotKey]: string } }` merged **once** at provide-time.
- Nuxt module and Vite plugin only if they add real value; a plain `app.use()` must be
  enough.

## Builder (app `builder`)

- Three-pane layout: element palette (from `defineElement` registry, searchable) /
  canvas (nested drag-and-drop, live preview using the real `<FormRenderer>` — the
  builder never has its own rendering code) / inspector (auto-generated from each
  element's Zod schema, with custom editors for rules, conditions, options, columns,
  translations).
- Condition and rule editors are visual (field picker, operator, value, AND/OR groups)
  and round-trip exactly to the `Condition`/`Rule` types; an "advanced" tab shows the
  JSON.
- Undo/redo (command stack over immutable schema snapshots), autosave to IndexedDB,
  import JSON, import legacy Vueform schema, keyboard-accessible DnD.
- Preview modes: desktop/tablet/mobile widths, every locale, light/dark, filled with
  fake data, "validate all".
- **Export panel** (this is the point of the product). Every option must be verified by
  an e2e test that creates a form in the builder, exports it, and runs the export in
  the matching `examples/*` project:
  1. **Schema JSON** — download or copy. Usable with `<FormRenderer :schema>`.
  2. **Vue SFC** — a generated `MyForm.vue` that imports the renderer and inlines the
     schema; optional "eject" variant that generates explicit `<TextElement …>` markup
     for people who want to hand-edit.
  3. **Web component snippet** — `<script type="module" src="…/form-runtime.js">
     <form-runtime schema-url="…">` for any site (WordPress, plain HTML, React…).
  4. **Hosted/embed** — optional: POST schema to a tiny storage API (`server`
     package exposes it) and get a share URL + iframe snippet.
  5. **Server validator** — a generated `validate.ts` for Node/Hono/Express that
     validates incoming payloads against the same schema.
  6. **TypeScript types** — `type MyFormData = { … }` generated from the schema.
- The builder itself is distributable: `npx <scope>/builder` starts it locally, and
  `<FormBuilderEmbed v-model:schema>` embeds the builder inside another Vue app (so a
  SaaS can give its users a form designer).

## Lessons from v1 — write a regression test for each before fixing

These are real bugs found in the old codebase. The new design must make them impossible
or at least tested:

1. `items.12.name` resolved to item **2** (regex kept only the last digit).
2. `SUM`/`AVG` used `parseInt` and dropped decimals.
3. A validator referenced an undefined variable in `onerror`; validation stayed
   `pending` forever and the form could never submit → every async path must `finally`
   clear pending.
4. OR-groups in conditional rules called the wrong function and registered the wrong
   dependencies.
5. `sanitizeInit` ran on every call, piling up DOMPurify hooks.
6. `>` ignored strict-conditions while `>=`, `<`, `<=` honoured it.
7. Numeric normalisation accepted `"--5"` (→ NaN) and ignored negative floats.
8. Indexes were sorted as strings (`[2, 10]` → `[10, 2]`), removing the wrong item.
9. One File element mutated the global endpoints config for every other file element.
10. Async-items watchers kept firing HTTP requests after the element unmounted;
    Sortable, Google Places, radio change listeners and signature timers also leaked.
11. Debounced validate() dropped the earlier promise (callers awaited forever).
12. Unauthenticated (401) responses never resolved or rejected when a handler was set.
13. `FormMessages` rendered server messages with `v-html` unsanitized.
14. `regex:/…/i` lost its flags; `not_in` compared `"1"` against `1`.
15. Upload abort didn't cancel function endpoints and surfaced as unhandled rejection.
16. Extension checks were case-sensitive (`.jpg` rejected `PHOTO.JPG`).
17. A theme's "nodark" stylesheet still imported the dark-mode partial.
18. Packages used by `src/` were listed as devDependencies, so `./src` imports broke.

## Phases (each ends green, documented, committed)

- **Phase 0 — Scaffold.** Monorepo, tooling, CI (lint, typecheck, unit, e2e, bundle-size
  check), `DECISIONS.md`, `CONTRIBUTING.md`. Empty packages with one passing test each.
- **Phase 1 — Schema + Core vertical slice.** Schema v1 with the Phase-1 element types,
  `createForm`, value/dirty/touched, `required|min|max|email|regex|same|in`, conditions
  (leaf + and/or/not + expr), expression parser with the function table, i18n with 3
  locales, JSON submit. 100% of "Lessons" 1–8 covered by tests. Server validator works
  in Node with the same schema.
- **Phase 2 — Vue renderer.** `<FormRenderer>` with Phase-1 elements, default + tailwind
  + unstyled themes, a11y, mount/unmount leak test, playground app, docs site skeleton.
- **Phase 3 — Builder MVP.** Palette/canvas/inspector, undo/redo, autosave, Export →
  Schema JSON and Vue SFC, `examples/vite-vue` consuming the export via the *published*
  packages (use `pnpm pack` + local registry like Verdaccio in CI).
- **Phase 4 — Structure.** object/group/list/grid/matrix, steps, tabs, legacy Vueform
  importer, conditional rules editor, translations editor, web-component export +
  `examples/plain-html`.
- **Phase 5 — Rich elements.** date/time, file/multifile with temp-upload + abort,
  editor, signature, slider, phone, location, tags, captcha — each lazy-loaded, each
  with its builder inspector and docs page.
- **Phase 6 — Remaining rules, locales, polish.** Full 50+ rule parity, 31 locales,
  hosted embed, `FormBuilderEmbed`, performance pass (1,000-element form renders and
  validates < 100 ms per keystroke), bundle budget enforced in CI, 1.0 release notes.

## Definition of done (for every phase)

- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build` all green.
- No `any` outside explicitly justified `// reason:` comments.
- Each new public API has a docs page with a live example.
- `CHANGELOG.md` entry; conventional commits.
- Ask me before: adding a runtime dependency, changing the schema shape after Phase 1,
  or skipping a test.

Start with Phase 0. Before writing code, print a one-page plan for the phase, the files
you will create, and any decision you need from me. Then proceed.
