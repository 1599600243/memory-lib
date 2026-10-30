import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConversationMemory } from "../src/conversation-memory.mjs";
import { createMemoryLib } from "../src/memory-lib.mjs";

function conversation(id, capturedAt, body = `body-${id}`, calendar = null) {
  const calendarDate = calendar?.calendarDate ?? capturedAt.slice(0, 10);
  const calendarTimezone = calendar?.calendarTimezone ?? "UTC";
  return [`---`, `id: ${id}`, `type: conversation`, `capturedAt: ${capturedAt}`, `calendarDate: ${calendarDate}`, `calendarTimezone: ${JSON.stringify(calendarTimezone)}`, `groupId: group-day`, `userId: user-day`, `---`, "", body].join("\n");
}

async function conversationRoot(label, files) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `memory-lib-dayrecall-${label}-`));
  const root = path.join(tmp, "evidence", "conversations");
  await fs.mkdir(root, { recursive: true });
  for (const [name, text] of files) await fs.writeFile(path.join(root, name), text, "utf8");
  return { tmp, root };
}

function conversationLib(tmp, root, principal = { group_id: "group-day", user_id: "user-day", agent_id: "pilot-01", role_id: "researcher" }) {
  return createMemoryLib({ dataRoot: tmp, workspaceRoot: tmp, principal, resolvedRoots: [root], vectorLane: { probe: false } });
}

test("capture materializes calendar fields without putting dates in conversation body", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lib-dayrecall-capture-"));
  try {
    const memory = createConversationMemory({ dataRoot: tmp, calendarTimezone: "UTC" });
    const result = await memory.capture({
      conversationId: "day-capture",
      eventId: "day-capture-event",
      source: "dayrecall-test",
      messages: [{ role: "user", content: "calendar derived field test" }],
      principal: { group_id: "group-day", user_id: "user-day", agent_id: "pilot-01", role_id: "researcher" },
    });
    const text = await fs.readFile(result.evidencePath, "utf8");
    assert.match(text, /calendarDate: \d{4}-\d{2}-\d{2}/u);
    assert.match(text, /calendarTimezone: ["']?UTC["']?/u);
    assert.doesNotMatch(text.split("# 原始对话记录")[1], /calendarDate|calendarTimezone/iu);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test("the same capturedAt receives different calendar dates under different write timezones", async () => {
  const { calendarFields } = await import("../src/conversation-memory.mjs");
  assert.deepEqual(calendarFields("2026-10-10T01:30:00.000Z", "UTC"), { calendarDate: "2026-10-10", calendarTimezone: "UTC" });
  assert.deepEqual(calendarFields("2026-10-10T01:30:00.000Z", "America/Los_Angeles"), { calendarDate: "2026-10-09", calendarTimezone: "America/Los_Angeles" });
});

// A-2: calendarDate filter must equal the equivalent since/until enumeration in BOTH
// set membership and order, and must resolve to the correct half-open local-day window.
test("calendarDate filtering equals the equivalent since/until enumeration in set and order", async () => {
  const { tmp, root } = await conversationRoot("equivalent", [
    // inside 2026-10-10 (UTC)
    ["b.md", conversation("b", "2026-10-10T01:00:00.000Z")],
    ["a.md", conversation("a", "2026-10-10T00:00:00.000Z")],
    ["c.md", conversation("c", "2026-10-10T23:59:59.999Z")],
    // outside, one millisecond on each side
    ["before.md", conversation("before", "2026-10-09T23:59:59.999Z")],
    ["after.md", conversation("after", "2026-10-11T00:00:00.000Z")],
  ]);
  try {
    const lib = conversationLib(tmp, root);
    const byCalendar = await lib.timeline({ calendarDate: "2026-10-10", calendarTimezone: "UTC", limit: 10 });
    const byRange = await lib.timeline({ since: "2026-10-10T00:00:00.000Z", until: "2026-10-10T23:59:59.999Z", limit: 10 });

    // Order contract: capturedAt ASC, id ASC.
    assert.deepEqual(byCalendar.results.map((item) => item.id), ["a", "b", "c"]);
    assert.equal(byCalendar.total_count, 3);
    assert.equal(byCalendar.nextCursor, null);
    assert.equal(byCalendar.hasMore, false);

    // Same set AND same order, both ways.
    assert.deepEqual(byCalendar.results.map((item) => item.id), byRange.results.map((item) => item.id));
    // DAY-INTERVAL-1：resolvedRange 现在**多带一个** untilExclusive（半开区间真值）——
    // 纯**新增**字段，since/until/calendarTimezone 的取值与含义都没变，所以这是按新契约补断言，
    // 不是"改到能过"。
    assert.deepEqual(byCalendar.resolvedRange, {
      since: "2026-10-10T00:00:00.000Z",
      until: "2026-10-10T23:59:59.999Z",
      untilExclusive: "2026-10-11T00:00:00.000Z",
      calendarTimezone: "UTC",
      calendarDate: "2026-10-10",
    });
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// A-3: the local day is a property of (capturedAt, timezone). A non-UTC calendar day
// must resolve to the true UTC window for that zone -- not shifted by the offset.
test("a non-UTC calendar day resolves to that zone's true UTC window", async () => {
  const { tmp, root } = await conversationRoot("tz-window", [
    ["a.md", conversation("a", "2026-10-09T23:30:00.000Z")],
  ]);
  try {
    const lib = conversationLib(tmp, root);
    const byCalendar = await lib.timeline({ calendarDate: "2026-10-10", calendarTimezone: "Asia/Shanghai", limit: 10 });
    // 2026-10-10 exists in Asia/Shanghai from 2026-10-09T16:00:00Z (inclusive)
    // through 2026-10-10T15:59:59.999Z (inclusive).
    assert.deepEqual(byCalendar.resolvedRange, {
      since: "2026-10-09T16:00:00.000Z",
      until: "2026-10-10T15:59:59.999Z",
      untilExclusive: "2026-10-10T16:00:00.000Z",
      calendarTimezone: "Asia/Shanghai",
      calendarDate: "2026-10-10",
    });
    assert.deepEqual(byCalendar.results.map((item) => item.id), ["a"]);

    // The next local day starts exactly one millisecond after that window's end.
    const nextDay = await lib.timeline({ calendarDate: "2026-10-11", calendarTimezone: "Asia/Shanghai", limit: 10 });
    assert.deepEqual(nextDay.results.map((item) => item.id), []);
    assert.equal(nextDay.resolvedRange.since, "2026-10-10T16:00:00.000Z");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// A-4: cross-timezone semantics. The immutable truth is capturedAt; calendarDate is a
// derived value that must be recomputed for the query timezone, so the same instant is
// deliberately reachable as different calendar days -- and the stored (write-time)
// calendarTimezone must never exclude an item from the queried day.
test("the same capturedAt lands on different calendar days under different query timezones", async () => {
  const instant = "2026-10-09T23:30:00.000Z";
  const { tmp, root } = await conversationRoot("cross-tz", [
    // Written under UTC, so the stored derived fields say 2026-10-09 / UTC.
    ["utc.md", conversation("utc", instant, "body-utc", { calendarDate: "2026-10-09", calendarTimezone: "UTC" })],
    // Same instant, written under Asia/Shanghai, so the stored derived fields say 2026-10-10 / Asia/Shanghai.
    ["sh.md", conversation("sh", instant, "body-sh", { calendarDate: "2026-10-10", calendarTimezone: "Asia/Shanghai" })],
  ]);
  try {
    const lib = conversationLib(tmp, root);

    // Queried as the UTC day: both items belong to 2026-10-09.
    // Same capturedAt, so the id tie-breaker fixes the order (not alphabetical luck).
    const asUtc = await lib.timeline({ calendarDate: "2026-10-09", calendarTimezone: "UTC", limit: 10 });
    assert.deepEqual(asUtc.results.map((item) => item.id), ["sh", "utc"]);

    // Queried as the Asia/Shanghai day: the SAME two instants belong to 2026-10-10,
    // regardless of which timezone they were written under.
    const asShanghai = await lib.timeline({ calendarDate: "2026-10-10", calendarTimezone: "Asia/Shanghai", limit: 10 });
    assert.deepEqual(asShanghai.results.map((item) => item.id), ["sh", "utc"]);

    // And the same instant is NOT in both days under one zone.
    const shanghaiDay9 = await lib.timeline({ calendarDate: "2026-10-09", calendarTimezone: "Asia/Shanghai", limit: 10 });
    assert.deepEqual(shanghaiDay9.results.map((item) => item.id), []);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// A-5: a UTC-instant end bound is wrong on a day that is not 24 hours long.
// Australia/Lord_Howe uses a 30-minute DST shift; 2026-10-04 is its spring-forward day.
test("the local-day window is derived from the next local midnight, not a fixed 24 hours", async () => {
  const { tmp, root } = await conversationRoot("dst", []);
  try {
    const lib = conversationLib(tmp, root);
    const shortDay = await lib.timeline({ calendarDate: "2026-10-04", calendarTimezone: "Australia/Lord_Howe", limit: 10 });
    assert.equal(shortDay.resolvedRange.since, "2026-10-03T13:30:00.000Z");
    // 23.5 hours later, because the clocks moved forward 30 minutes at 02:00 local.
    assert.equal(shortDay.resolvedRange.until, "2026-10-04T12:59:59.999Z");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// A-6: the timezone used to derive the fields must come from the server option, and an
// unknown zone must fail loudly rather than silently fall back to UTC.
test("an invalid calendarTimezone is rejected instead of silently meaning UTC", async () => {
  const { tmp, root } = await conversationRoot("bad-tz", [
    ["a.md", conversation("a", "2026-10-10T01:00:00.000Z")],
  ]);
  try {
    const lib = conversationLib(tmp, root);
    await assert.rejects(
      () => lib.timeline({ calendarDate: "2026-10-10", calendarTimezone: "Not/AZone", limit: 10 }),
      /timezone/iu,
    );
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// B: keyset paging must neither duplicate nor drop already-existing entries when new
// entries are inserted mid-traversal -- once into the already-paged region and once into
// the not-yet-paged region. The two insertions are asserted separately because they have
// deliberately different visibility in this traversal.
test("keyset cursor neither duplicates nor drops entries across mid-traversal inserts", async () => {
  const { tmp, root } = await conversationRoot("cursor", [
    ["c.md", conversation("c", "2026-10-10T03:00:00.000Z")],
    ["b.md", conversation("b", "2026-10-10T01:00:00.000Z")],
    ["a.md", conversation("a", "2026-10-10T00:00:00.000Z")],
    ["e.md", conversation("e", "2026-10-10T05:00:00.000Z")],
    ["d.md", conversation("d", "2026-10-10T04:00:00.000Z")],
  ]);
  try {
    const lib = conversationLib(tmp, root, { group_id: "group-day", user_id: "user-day" });

    const page1 = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", limit: 2 });
    assert.deepEqual(page1.results.map((item) => item.id), ["a", "b"]);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.nextCursor, "first page must hand out a cursor");
    assert.equal(page1.total_count, 5);

    // Insert two new entries while the traversal is in flight.
    //  - "inserted-before" sorts into the region already paged past (00:00 < 00:30 < 01:00).
    //  - "inserted-after" sorts into the region still to come (02:00 > 01:00).
    await fs.writeFile(path.join(root, "inserted-before.md"), conversation("inserted-before", "2026-10-10T00:30:00.000Z"), "utf8");
    await fs.writeFile(path.join(root, "inserted-after.md"), conversation("inserted-after", "2026-10-10T02:00:00.000Z"), "utf8");

    const seen = [...page1.results.map((item) => item.id)];
    let cursor = page1.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", limit: 2, cursor });
      const ids = page.results.map((item) => item.id);
      assert.equal(ids.length > 0, true, "a non-null cursor must always advance");
      seen.push(...ids);
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 10, "traversal must terminate");
    }

    // No duplicates across the whole traversal.
    assert.equal(new Set(seen).size, seen.length, `duplicate ids in traversal: ${seen.join(",")}`);
    // No omissions: every entry that existed when the traversal started was returned.
    const original = ["a", "b", "c", "d", "e"];
    for (const id of original) assert.ok(seen.includes(id), `entry ${id} was dropped by the traversal`);

    // Inserted into the not-yet-paged region: seen by this traversal.
    assert.ok(seen.includes("inserted-after"), "an insert ahead of the cursor should be visible");
    // Inserted into the already-paged region: NOT seen, because the cursor is a position
    // in the ordered sequence, so anything sorting before it is behind us.
    assert.equal(seen.includes("inserted-before"), false, "an insert behind the cursor is outside this traversal");
    // Order contract: capturedAt ASC, id ASC.
    assert.deepEqual(seen, ["a", "b", "inserted-after", "c", "d", "e"]);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// B-3: the legacy offset path must keep working exactly as before (no silent change),
// and its known concurrent-write weakness must be pinned down by a test rather than
// left as prose. offset counts positions, so an insert into the already-paged region
// shifts the window and re-serves an entry that was already returned.
test("legacy offset paging is unchanged, and its concurrent-insert weakness is pinned as documented", async () => {
  const { tmp, root } = await conversationRoot("legacy-offset", [
    ["a.md", conversation("a", "2026-10-10T00:00:00.000Z")],
    ["b.md", conversation("b", "2026-10-10T01:00:00.000Z")],
    ["c.md", conversation("c", "2026-10-10T02:00:00.000Z")],
    ["d.md", conversation("d", "2026-10-10T03:00:00.000Z")],
  ]);
  try {
    const lib = conversationLib(tmp, root, { group_id: "group-day", user_id: "user-day" });

    // Purely static data: offset paging is correct and still reports the legacy fields.
    const first = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", limit: 2 });
    assert.deepEqual(first.results.map((item) => item.id), ["a", "b"]);
    assert.equal(first.offset, 0);
    assert.equal(first.next_offset, 2);
    assert.equal(first.has_more, true);
    const second = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", limit: 2, offset: first.next_offset });
    assert.deepEqual(second.results.map((item) => item.id), ["c", "d"]);
    assert.equal(second.next_offset, null);
    assert.equal(second.has_more, false);

    // Now the documented weakness. Insert "a0" INTO the already-paged region (00:00 < 00:30 < 01:00),
    // then continue with offset -- exactly what a client following the legacy contract does.
    await fs.writeFile(path.join(root, "a0.md"), conversation("a0", "2026-10-10T00:30:00.000Z"), "utf8");
    const legacyContinue = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", limit: 2, offset: 2 });
    const legacySeen = [...first.results.map((item) => item.id), ...legacyContinue.results.map((item) => item.id)];
    // "b" is served twice: the insert pushed it from position 1 to position 2.
    assert.deepEqual(legacyContinue.results.map((item) => item.id), ["b", "c"]);
    assert.equal(new Set(legacySeen).size, legacySeen.length - 1, "offset paging duplicates b after an insert behind the window");
    assert.equal(legacySeen.filter((id) => id === "b").length, 2);

    // The keyset cursor over the same data does not have that failure: restart from page 1
    // with a cursor and the insert behind it is simply out of scope, with no duplicate.
    const keysetFirst = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", limit: 2 });
    const keysetRest = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", limit: 10, cursor: keysetFirst.nextCursor });
    const keysetSeen = [...keysetFirst.results.map((item) => item.id), ...keysetRest.results.map((item) => item.id)];
    assert.deepEqual(keysetFirst.results.map((item) => item.id), ["a", "a0"]);
    assert.deepEqual(keysetRest.results.map((item) => item.id), ["b", "c", "d"]);
    assert.equal(new Set(keysetSeen).size, keysetSeen.length, "keyset paging must not duplicate");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});


test("entries sharing a capturedAt are paged exactly once each", async () => {
  const same = "2026-10-10T02:00:00.000Z";
  const { tmp, root } = await conversationRoot("tie", [
    ["t3.md", conversation("t3", same)],
    ["t1.md", conversation("t1", same)],
    ["t2.md", conversation("t2", same)],
  ]);
  try {
    const lib = conversationLib(tmp, root, { group_id: "group-day", user_id: "user-day" });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await lib.timeline({ since: "2026-10-10", until: "2026-10-10", limit: 1, cursor });
      seen.push(...page.results.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 10, "traversal must terminate");
    } while (cursor);
    assert.deepEqual(seen, ["t1", "t2", "t3"]);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
