Review {{label}} of project {{project}} (ref: {{ref}}{{baseNote}}) through the lean-agent:review skill. Never review by hand: a review without the skill leaves no record and no reviewer pass, and your done report is refused without one.
1. Load the skill lean-agent:review and read its "External review" section.
2. lean_review prepare with ref "{{ref}}"{{baseArg}} at level "full". Run the reviewer passes it asks for, exactly as it says (the reviewer agent, two runs when it says so).
3. lean_review record with mode "external" and the head sha that prepare printed.
4. lean_report done: the verdict and the findings by severity, one line each. The mod appends the evidence (record sha, level, passes, verdicts, findings by severity) from its own store.
Review only what this change adds or changes: existing code is context only; report nothing about a file or line outside the changed hunks; if an unchanged file shows a problem the change makes worse (a caller broken by the change), report it as a finding ON THE CHANGED LINE that causes it. Every finding is `file:line` of a changed range the prepare text lists plus a one-line reason; other files are read only to understand, never to report on; a finding with no changed line, or about something absent, is dropped and counted.
Read only: edit nothing, push nothing, post no comment on the PR unless the user asks.
