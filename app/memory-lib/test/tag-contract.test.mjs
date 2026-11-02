import assert from "node:assert/strict";
import test from "node:test";
import { invalidReservedTags, reservedTagViolation } from "../src/tag-contract.mjs";

test("valid reserved tags pass", () => {
  for (const tag of [
    "place:group:1000000",
    "place:channel:qq-napcat",
    "audience:group",
    "audience:c2c",
    "speaker:玉轩",
    "speaker_id:qq-bot",
  ]) {
    assert.equal(reservedTagViolation(tag), null, tag);
  }
});

test("non-reserved tags are not constrained", () => {
  for (const tag of ["being", "event", "CrossChannel", "随便 的 标签"]) {
    assert.equal(reservedTagViolation(tag), null, tag);
  }
});

test("malformed reserved tags are rejected with a reason", () => {
  const cases = {
    "place:group": "PLACE_FORMAT",
    "place:guild:123": "PLACE_FORMAT",
    "place:group:有空格 123": "CONTAINS_SPACE",
    "audience:everyone": "AUDIENCE_FORMAT",
    "speaker_id:玉轩": "SPEAKER_ID_FORMAT",
  };
  for (const [tag, reason] of Object.entries(cases)) {
    const violation = reservedTagViolation(tag);
    assert.equal(violation?.reason, reason, `${tag} → ${JSON.stringify(violation)}`);
  }
});

test("invalidReservedTags reports every bad tag", () => {
  const bad = invalidReservedTags(["being", "place:group", "audience:nobody", "speaker:甲"]);
  assert.deepEqual(bad.map((item) => item.tag), ["place:group", "audience:nobody"]);
});
