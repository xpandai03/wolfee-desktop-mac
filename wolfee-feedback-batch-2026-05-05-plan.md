# Wolfee Feedback Batch — 2026-05-05 — Execution Plan

Status: planning, **zero code changed**. Read-only.
Date: 2026-05-05
Source: live test session — sales-call mode, therapy-practice owner roleplay

---

## 0 — Summary of user feedback (verbatim → distilled)

| # | Theme | Distilled requirement |
|---|---|---|
| 1 | Fact-check is wishy-washy | "Salesforce does not have an API" → response talked around EHRs, never said TRUE/FALSE. Every fact-check should lead with a **bold verdict** (TRUE / FALSE / CORRECT / NOT CORRECT) checked against the live web, then context. |
| 2 | Tray "Pause Copilot" is confusing | Either give it a clear, observable behavior or remove it. |
| 3 | Tray "Start Session" + "Open Overlay" are split | Starting a session should always show the overlay. One action, not two. |
| 4 | Onboarding teaches setup, not usage | Add (un-skippable) cards explaining tray icon, hotkey ⌘⌥W, how to close the strip, pause/end. |
| 5 | Onboarding navigation inconsistent | Every step should have Back / Next / Skip. Bottom progress dots should be clickable to jump. |

---

## 1 — Workstream A: Fact-check verdict directness

### Current behavior (grounded in code)

- **Prompt lives in backend** — [WOLFEE-MVP/server/lib/copilot/intelligence/prompts.ts:478-540](../WOLFEE-MVP/server/lib/copilot/intelligence/prompts.ts#L478-L540).
- **Model:** OpenAI `gpt-4o-search-preview` via [llmClient.ts:57](../WOLFEE-MVP/server/lib/copilot/intelligence/llmClient.ts#L57). Web search is **already enabled** as a built-in tool of the search-preview model. The problem is not capability — it's prompt bias.
- **The bias:** the prompt has a `## CRITICAL: default to "outside our knowledge" when in doubt` section that pushes the model away from giving a verdict. From the prompt:
  > "For ANY claim about a specific product / vendor / integration / pricing / feature that is NOT covered by the rep's about_user context, the correct verdict is 'outside our knowledge' with confidence < 0.5."
- **Output schema** ([llmClient.ts:89](../WOLFEE-MVP/server/lib/copilot/intelligence/llmClient.ts#L89)): `verdict / claim / explanation / confidence / sources`. The verdict field already exists — it just defaults to a hedge.
- **Frontend rendering:** [overlay/src/components/ChatThread.tsx:287-290](overlay/src/components/ChatThread.tsx#L287-L290) — renders `primary` as a string blob, no special treatment of the verdict field.

### Diagnosis of "Salesforce does not have an API"

- The claim is verifiable on the public web (Salesforce has an extensively documented API platform). The model has web search.
- The prompt's "default to outside our knowledge" rule overrides that capability — the model stayed safe instead of answering.
- The frontend buried the verdict inside prose, so even if the model said "false," it didn't read as a verdict.

### Proposed changes

**Backend prompt (prompts.ts):**
1. Restructure `## CRITICAL` section: keep the no-invent rule, but add a stronger counter-rule: *"For verifiable factual claims (named vendors, public APIs, well-documented products, public pricing, named regulations), USE web_search and return a definitive verdict. 'Outside our knowledge' is reserved for genuinely unknowable claims (private contracts, internal stats)."*
2. Rename verdict enum for plain English: `"true" | "false" | "partly_true" | "unverifiable"` (current: `verified / outside our knowledge / questionable / no verifiable claim`).
3. Require `primary` field to **start with the verdict in caps**, e.g. `"FALSE — Salesforce has a robust REST/SOAP/Bulk API. The prospect is incorrect."`.
4. Add an example in the prompt for a publicly-verifiable claim that gets web-searched and answered confidently.

**Backend output schema (llmClient.ts):**
- Already has structured `verdict` field — keep. Add `verdict_label` (the short bold-ready string for the UI: `"TRUE"`, `"FALSE"`, `"PARTLY TRUE"`, `"UNVERIFIABLE"`).

**Frontend (ChatThread.tsx):**
- For fact-check moments, render `verdict_label` as a leading bold pill before `primary`. Color-code: green=TRUE, red=FALSE, amber=PARTLY TRUE, gray=UNVERIFIABLE.
- Sources row already works — keep. Encourage the model to populate it on every TRUE/FALSE.

### Files to touch

| File | Change |
|---|---|
| WOLFEE-MVP/server/lib/copilot/intelligence/prompts.ts | Rewrite fact-check prompt sections per above |
| WOLFEE-MVP/server/lib/copilot/intelligence/llmClient.ts | Add `verdict_label` to JSON schema, plumb through |
| WOLFEE-MVP/server/lib/copilot/intelligence/quickAction.ts | Pass `verdict_label` through to the wire payload |
| wolfee-desktop/overlay/src/components/ChatThread.tsx | Render verdict pill for fact_check moments |
| wolfee-desktop/overlay/src/state/types.ts | Extend `Suggestion` type with optional `verdictLabel` field |

### Open decisions

- Q: Do we keep the 4-state enum or collapse to 3 (drop `partly_true`)? Three is easier to reason about; four catches nuance. **Recommend 4.**
- Q: Should `UNVERIFIABLE` still be shown, or hidden? **Recommend showing it explicitly so the rep knows the model tried — silence reads worse.**

### Definition of done

- "Salesforce has no API" fact-check returns `FALSE` with one or two cited sources.
- "Our company's revenue last quarter was $50M" returns `UNVERIFIABLE` (private fact).
- "California has 39M people" returns `TRUE`.
- Verdict pill renders in the right color for each.

---

## 2 — Workstream B: Tray menu rationalization

### Current behavior

- **"Pause Copilot"** ([src-tauri/src/tray.rs:210-211](src-tauri/src/tray.rs#L210-L211) → [lib.rs:1722-1737](src-tauri/src/lib.rs#L1722-L1737)) — toggles `CopilotState::Paused ↔ Idle`. Blocks ⌘⌥W and the moment detector. **Does NOT mute audio capture or hide overlay.** The Sub-prompt 4.6 placeholder at [lib.rs:1963-1974](src-tauri/src/lib.rs#L1963-L1974) is even less — it just emits a UI event with hardcoded `paused: false`.
- **"Start Copilot Session"** ([tray.rs:154-161](src-tauri/src/tray.rs#L154-L161) → [lib.rs:1879](src-tauri/src/lib.rs#L1879)) — opens the **context-paste window** (separate window asking what the call is about). Does NOT show the overlay strip. The strip only appears when ⌘⌥W is pressed or when "Open Copilot Overlay" is clicked.
- **"Open Copilot Overlay"** ([tray.rs:125-132](src-tauri/src/tray.rs#L125-L132)) — toggles strip visibility.

### Why the user is confused

- "Pause" doesn't visibly pause anything — no UI change, no mic-mute, the overlay still listens.
- A rep starts a session and then has to also open the overlay separately, which feels redundant.

### Proposed changes

**Pause Copilot — pick one:**

| Option | Cost | UX clarity |
|---|---|---|
| **B1. Remove entirely.** End Session is the only stop control. | Cheapest. Lose one button. | High — no more confusion. |
| B2. Make it actually pause: mic stops, suggestions freeze, strip dims to gray. Resume re-arms everything. | Medium — needs to interlock with audio capture in `recorder.rs` and the SSE stream lifecycle. | High once it works. |
| B3. Rename to "Mute Mic" and just toggle the mic feed. | Low. | Medium — narrower than current promise. |

**Recommend B1** for this batch. Pause is a stretch goal that creates more questions than it answers when half-implemented. If users ask for it later, B2 is the right path.

**Start Session vs Open Overlay — unify:**

- "Start Copilot Session" should **auto-show the overlay strip after the context-paste window is closed**. Concretely: in [src-tauri/src/lib.rs](src-tauri/src/lib.rs) the `start-copilot-session` flow already opens the context window; once context is submitted and `Listening` state is reached, automatically call `window::show_overlay()`.
- Keep the "Open Copilot Overlay" tray item (it's still useful when overlay was hidden mid-session). But re-label it: **"Show Overlay"** when hidden, hide the item when overlay is already visible.
- Hotkey ⌘⌥W stays as the toggle.

### Files to touch

| File | Change |
|---|---|
| src-tauri/src/tray.rs | Remove "Pause Copilot" + "Resume" item. Conditionally hide "Open Copilot Overlay" when overlay visible. |
| src-tauri/src/lib.rs | Drop `toggle-copilot-pause` handler (and any tests). After session reaches `Listening`, call `window::show_overlay()`. |
| src-tauri/src/copilot/state.rs (or wherever `CopilotState` lives) | Drop `Paused` variant. Audit all match arms. |
| src-tauri/src/copilot/hotkey.rs | Remove the special handling that gates ⌘⌥G during `Paused`. |

### Open decisions

- Q: Does removing `Paused` break any persisted state? **Need to check** if `CopilotState` is serialized anywhere. If yes, migrate by mapping `Paused → Idle` on load.
- Q: Keep "Generate Suggestion" tray item ([tray.rs:192-199](src-tauri/src/tray.rs#L192-L199)) or also fold into overlay-only? **Keep for now** — it's hotkey-discoverable via tray.

### Definition of done

- Tray menu has one less item.
- Clicking "Start Copilot Session" → context window → submit → overlay strip appears automatically.
- No surprise "Pause" state.

---

## 3 — Workstream C: Onboarding usage cards

### Current behavior

- 6 steps in [overlay/src/components/onboarding/wizardCopy.ts](overlay/src/components/onboarding/wizardCopy.ts):
  1. What is Wolfee Copilot
  2. Listen / Suggest / Recap phases
  3. Pair the app to your account ← (just fixed)
  4. Permissions (mic + screen)
  5. Pick a mode (handoff to web)
  6. "You're ready" + 3 reminders
- Step 6's reminders are buried bullet points: `⌘⌥W toggles the overlay`, `Click the tray icon`, `Re-open this tour`.

### Proposed changes

Insert two new cards between steps 5 and 6, dedicated to learning the controls, with the **same illustration style** as existing steps. The wizard total bumps from 6 → 8.

**New Step 6: "Meet your tray icon"**
- Headline: "Wolfee lives in your menu bar"
- Body: arrow-pointing illustration of macOS menu bar with the Wolfee icon highlighted. Three points:
  - Click the icon to start, end, or check status
  - The icon shows a green dot when Copilot is listening
  - Right-click is the same as left-click — both open the menu
- CTA: Continue (no skip)

**New Step 7: "Two ways to bring up the overlay"**
- Headline: "The overlay is your real-time copilot"
- Body: split illustration showing strip (collapsed) vs expanded panel. Three points:
  - **⌘⌥W** toggles it from anywhere
  - **Esc** in the expanded panel collapses it back to a thin strip
  - The strip is invisible during screen-share — only you see it
- CTA: Continue (no skip)

**Step 8 (was 6): "You're ready"**
- Same as today, but trim the now-redundant bullets (those got their own cards).

### Make new steps un-skippable

- Add `hideSkip: true` to Steps 6 and 7 (the prop already exists — Step 6/today uses it: see [OnboardingWizard.tsx:210](overlay/src/components/onboarding/OnboardingWizard.tsx#L210)).
- User can still go Back from these steps — just no Skip Tour shortcut.

### Files to touch

| File | Change |
|---|---|
| overlay/src/components/onboarding/wizardCopy.ts | Add step6/7 entries. Bump `WIZARD_TOTAL_STEPS` to 8. Move existing step6 content to step8. |
| overlay/src/components/onboarding/illustrations.tsx | Add `Step6TrayIllustration` and `Step7OverlayIllustration` (style-match existing line-art). |
| overlay/src/components/onboarding/OnboardingWizard.tsx | Add the two new step renderers with `hideSkip`. Re-key existing step6 → step8. |
| overlay/src/state/overlayReducer.ts | Bump the `Math.min` clamp from 6 → 8 in `LOAD_ONBOARDING_FLAG`, `ADVANCE_STEP`, `JUMP_TO_STEP`, `PAIRING_COMPLETE` (currently caps at 6 — see [overlayReducer.ts:520, 532](overlay/src/state/overlayReducer.ts#L520-L532)). |
| src-tauri side persistence | Check if onboarding step is persisted — if so, ensure step 6 from old saves still loads cleanly (probably auto-OK since they'd all be ≤ 6 and we only widened the range). |

### Open decisions

- Q: Is "no Skip on usage cards" too aggressive for users who already know the product? **Recommend keeping no-skip for first launch; after Skip Tour or Complete fires once, the persisted `onboardingCompleted=true` means re-opens via tray let users navigate freely.** Worth verifying.
- Q: Should the "permissions denied" path still bypass these new cards? **Yes** — if the user denied perms, getting them to grant comes first; usage tour is still reachable from tray afterwards.

### Definition of done

- Fresh install walkthrough hits 8 steps, two of which teach controls.
- Re-opening the tour from tray (when already completed) lands at step 1 and lets the user click freely.
- Step 6 (tray) explicitly mentions ⌘⌥W or step 7 does — verify before shipping that the hotkey shown matches what's actually registered ([hotkey.rs:16-23](src-tauri/src/copilot/hotkey.rs#L16-L23)).

---

## 4 — Workstream D: Onboarding navigation consistency

### Current behavior

- Step 1: only Continue + Skip (no Back — fine, it's the first).
- Step 2: Continue + Back + Skip ✅
- Step 3 (paired today): Continue (or auto-advance) + Back + Skip
- Step 4: Continue + Back + Skip
- Step 5: Continue + Back + Skip
- Step 6: Get Started + Skip (no Back — bug; user can't review reminders if they read too fast)
- Bottom dots ([StepLayout.tsx](overlay/src/components/onboarding/StepLayout.tsx) — assumed by inference; verify): not clickable, decorative only.

### Proposed changes

1. **Add Back button to step 6 (and the new 7/8 from Workstream C).** The only step that legitimately has no Back is step 1.
2. **Make progress dots clickable.** Each dot dispatches `JUMP_TO_STEP` (already exists in the reducer at [overlayReducer.ts:529-533](overlay/src/state/overlayReducer.ts#L529-L533)). Constraint: only allow jumping to steps the user has *already reached* — clicking a future dot is a no-op or a faint hint that they need to continue. Track `maxStepReached` in state.
3. **Standardize button labels:** `← Back` left, `Continue →` right, `Skip tour` top-right. Already mostly true — audit for stragglers.

### Files to touch

| File | Change |
|---|---|
| overlay/src/components/onboarding/StepLayout.tsx | Make progress dots into buttons with disabled state for future steps. Add visual hover/focus for reached dots. |
| overlay/src/components/onboarding/OnboardingWizard.tsx | Add Back to step 6. Pass `maxStepReached` and a `onJumpStep(n)` callback. |
| overlay/src/state/types.ts | Add `onboardingMaxStepReached: number` field. |
| overlay/src/state/overlayReducer.ts | On `ADVANCE_STEP`, bump `onboardingMaxStepReached = Math.max(prev, newStep)`. |

### Open decisions

- Q: Should clicking a future dot show a tooltip ("complete the current step first") or be silently disabled? **Recommend silent disabled** — tooltips on dots feel chatty. Just gray them out.
- Q: Persistence of `maxStepReached` — does Rust-side `mark-onboarding-step` already track the high-water mark? **Need to check.** If not, add a separate `mark-onboarding-max-reached` action so re-opens restore the right click-state.

### Definition of done

- Every step except step 1 has a Back button.
- Progress dots are clickable for any step you've already reached; future dots are visibly disabled.
- After completing the tour and re-opening from tray, all dots are clickable.

---

## 5 — Sequencing recommendation

### Order of execution

1. **D (navigation consistency)** — small, pure-frontend, low risk. Ship first. ~½ day.
2. **C (usage cards)** — additive frontend + reducer clamp bumps. Builds on D. ~1 day including illustrations.
3. **B (tray rationalization)** — Rust-side; tray + state machine. Independent of A/C/D. ~½ day.
4. **A (fact-check)** — backend prompt + frontend pill. Touches a separate repo (WOLFEE-MVP). ~1 day including testing prompt iterations against 5–10 real claims.

A and B/C/D can run in parallel since they don't share files. C must follow D so the Back/dot work covers the new steps from day one.

### Cut points if time is tight

- **Must ship:** A (fact-check verdict directness — biggest user-visible value), C (usage cards — onboarding gap is real).
- **Nice to have:** D (dot click-jumping), B (pause removal — purely cleanup).

---

## 6 — Risks & open threads

| Risk | Mitigation |
|---|---|
| Prompt change in A regresses other quick-actions (ask, follow_up, recap) | Fact-check has its own prompt template via `PROMPT_FOR.fact_check` — isolated. Verify with [quickAction.ts:565](../WOLFEE-MVP/server/lib/copilot/intelligence/quickAction.ts#L565). |
| Removing `Paused` variant breaks deserialize on update | Audit serde derives on `CopilotState`. If serialized, add `#[serde(other)] Idle` fallback or migration. |
| Bumping wizard from 6 → 8 confuses users mid-tour after auto-update | Acceptable — they re-enter at their persisted step (clamped); worst case they see step 6 (new content) when expecting old step 6. The new content is additive, not contradictory. |
| Clickable dots feel "complete" before they really are (user clicks ahead, misses content) | Disabled-future-dots policy prevents this. |
| Fact-check verdict pill in red ("FALSE") feels accusatory in a sales call | Soften wording: "FALSE — actually, Salesforce…" rather than "WRONG". Verdict label is structural; primary text owns the diplomacy. |

---

## End of plan

Next step: pick which workstream to start, or approve the whole sequence and I'll execute D→C→B in parallel with A.
