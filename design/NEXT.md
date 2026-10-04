# Tempo: where we stopped (resume when the user says "continue")

Pushed and live: v73 (party roles, filter, guest Off fix, party security hardening).
Branch claude/kind-darwin-yl7d1i. Repo clean at time of writing.

## To do, in order (build locally, test, then commit + push once at the end)
1. Remaining review findings (review-journal.jsonl: abuse findings already fixed in v73;
   check any 'state'/'ui' results in the journal and fix the real ones).
2. UI remake = "immersive" direction the user approved (design/immersive.css (in this folder) +
   design/immersive-shots.cjs; screenshots design/immersive-*.png). Use explore/ui-spec.md
   if it exists (design lead may not have finished). Rules: limit backdrop-filter to the dock,
   rail and dial lens; chip icons in markup (index.html) not script; fix phone Sounds page
   (bottom nav overlapped the 3D room); keep every JS hook id/class.
3. Perf fixes: see perf-audit result in explore-journal.jsonl (if it finished).
4. New features: ideas in explore-journal.jsonl. Strong picks: party reactions/high-fives,
   synced 3-2-1 party start, park-a-thought (distraction parking), streak flame + freezes,
   focus/break soundscapes, "just 2 minutes" start, exam countdowns.
5. README + What's new (next id 29), bump.sh, final.cjs + party5/7/8/9/2 tests, commit, push.

Test servers: static on :8080, MQTT broker ws://127.0.0.1:8883 (scratchpad/party/broker.cjs).
