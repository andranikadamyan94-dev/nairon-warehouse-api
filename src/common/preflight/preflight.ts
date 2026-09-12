/**
 * Action preflight: "could this person do this, right now?"
 *
 * The assistant shows a person what a change will do and asks them to agree
 * before anything happens. Without a way to ask the owning service first, it
 * could only check that the person can SEE the thing — and then show a
 * confirmation card for a rename they are not allowed to make, which the
 * service refuses a moment later. The fix is not to copy the rule into the
 * assistant. It is to let the service answer the question with the rule it
 * already has.
 *
 * THE PATTERN
 *
 *   POST <resource>/preflight/<action>        with the same body the mutation takes
 *
 * sits next to the mutation, behind the same guards, and calls the SAME
 * assert function the mutation calls before it writes. It answers 200
 * `{ ok: true }` when the action would be accepted, and otherwise throws
 * exactly what the mutation would throw — the same private 404, the same 403,
 * the same business-rule sentence. It writes nothing and notifies nobody.
 *
 * WHAT IT IS NOT
 *
 * It is UX validation, not authorization. A successful preflight grants
 * nothing and must never be cached as permission: time passes between the
 * question and the click, and the mutation runs the same checks again,
 * authoritatively, immediately before it writes.
 */
export type PreflightAnswer = { ok: true };

export const PREFLIGHT_OK: PreflightAnswer = Object.freeze({ ok: true as const });
