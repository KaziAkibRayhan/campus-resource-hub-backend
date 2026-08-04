const test = require("node:test");
const assert = require("node:assert/strict");
const { chunkText } = require("../utils/resourceKnowledge");

test("resource text is split into readable overlapping chunks", () => {
  const input = Array.from({ length: 500 }, (_, index) => `topic${index}`).join(" ");
  const chunks = chunkText([input]);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1200));
  const firstTail = chunks[0].text.split(" ").at(-1);
  assert.ok(chunks[1].text.includes(firstTail));
});

test("resource chunking normalizes whitespace and skips empty input", () => {
  assert.deepEqual(chunkText(["  ", "\n"]), []);
  assert.equal(chunkText(["one\n\n two\tthree"])[0].text, "one two three");
});
